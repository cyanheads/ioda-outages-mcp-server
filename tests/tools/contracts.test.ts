/**
 * @fileoverview Public IODA contracts exercised through the injected HTTP boundary.
 * @module tests/tools/contracts
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOutages } from '../../src/mcp-server/tools/definitions/find-outages.tool.js';
import { getAlerts } from '../../src/mcp-server/tools/definitions/get-alerts.tool.js';
import { getSignals } from '../../src/mcp-server/tools/definitions/get-signals.tool.js';
import { getStatus } from '../../src/mcp-server/tools/definitions/get-status.tool.js';
import { searchEntities } from '../../src/mcp-server/tools/definitions/search-entities.tool.js';
import { summarizeOutages } from '../../src/mcp-server/tools/definitions/summarize-outages.tool.js';
import {
  clampExtendWindow,
  clampLimit,
  clampLookbackHours,
  clampMaxPoints,
  composeEnrichment,
  entityFilter,
  relatedScope,
  renderJson,
  SERVED_CAPS,
} from '../../src/mcp-server/tools/ioda-common.js';
import { recoveryFor } from '../../src/services/ioda/errors.js';
import {
  AlertSchema,
  disposeIodaService,
  initIodaService,
  ProvenanceSchema,
} from '../../src/services/ioda/index.js';

const now = 1792540800000;
const window = { from: now / 1000 - 3600, until: now / 1000 };
const entityInput = { entityType: 'country', entityCode: 'US' };
const hostile = 'line one\r\n\t``` [do this](https://hostile.invalid/)\n</script> 雪';
const entity = { code: 'US', name: hostile, attrs: { deep: [{ text: hostile, nil: null }] } };
const alert = {
  entity,
  datasource: 'bgp',
  time: window.from,
  level: 'recovery',
  value: 0,
  historyValue: null,
  condition: hostile,
  unknown: { nested: [hostile] },
};
const event = {
  entity,
  from: window.from - 86400,
  until: window.until,
  score: 3,
  datasource: 'bgp',
  alerts: [alert],
  unknown: [{ nested: hostile }],
};
type Result = Awaited<ReturnType<typeof runToolContract>>;
const calls: URL[] = [];
/** IODA's /datasources units, verbatim. */
const units = {
  bgp: 'Visible /24s',
  'ping-slash24': 'Up /24s',
  'merit-nt': 'Unique Source IPs',
} as const;
/** Closes an empty first scoped page: IODA lists nothing within an unknown relatedToCode. */
const verifyScope =
  'IODA returns an empty page rather than an error for an unknown relatedToCode; call ioda_search_entities with relatedToType as entityType and relatedToCode as entityCode to verify it.';

function network(respond: (url: URL) => Response) {
  disposeIodaService();
  initIodaService({
    fetch: (async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.ioda.inetintel.cc.gatech.edu');
      calls.push(url);
      return respond(url);
    }) as typeof fetch,
  });
}
function envelope(data: unknown) {
  return Response.json({
    error: null,
    data,
    metadata: { requestTime: hostile, responseTime: { nested: [hostile] } },
    copyright: hostile,
  });
}
function text(result: Result) {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}
/** Row/default guidance remains exact; outage-semantics tests independently assert full membership recovery. */
function rowGuidance(notice: unknown): unknown {
  if (typeof notice !== 'string') return notice;
  return (
    notice.replace(
      /^Membership coverage is unverified:[\s\S]*?keeping all filters and limit fixed across its pages\.(?: |$)/,
      '',
    ) || undefined
  );
}
/** Decode JSON fences without calling the production renderer or byte counter. */
function parity(result: Result) {
  expect(result.isError).not.toBe(true);
  const rendered = text(result);
  const blocks: Record<string, unknown>[] = [];
  const lines = rendered.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const opening = /^(`{3,})json$/.exec(lines[i] ?? '');
    if (!opening) continue;
    const json: string[] = [];
    while (++i < lines.length && lines[i] !== opening[1]) json.push(lines[i] ?? '');
    expect(lines[i]).toBe(opening[1]);
    blocks.push(JSON.parse(json.join('\n')));
  }
  expect(blocks.length).toBeGreaterThan(1);
  expect(Object.assign({}, ...blocks)).toEqual(result.structuredContent);
  const data = result.structuredContent as Record<string, unknown>;
  expect(data.applied).toBeDefined();
  const endpoints = [...rendered.matchAll(/\[IODA endpoint\]\(<([^>]+)>\)/g)].map(
    (match) => match[1],
  );
  const provenances = data.provenance
    ? [data.provenance]
    : (data.components as { provenance?: unknown }[]).flatMap((part) =>
        part.provenance ? [part.provenance] : [],
      );
  expect(endpoints).toEqual(
    provenances.map((provenance) => (provenance as { endpoint: string }).endpoint),
  );
  return data;
}
function failure(result: Result, code: number, reason?: string) {
  expect(result.isError).toBe(true);
  const error = (
    result.structuredContent as {
      error: {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint: string } };
      };
    }
  ).error;
  expect(error.code).toBe(code);
  if (reason) {
    expect(error.data?.reason).toBe(reason);
    expect(error.data?.recovery?.hint).toMatch(/ioda_/);
    expect(text(result)).toContain(error.data?.recovery?.hint);
  }
  return error;
}
const lexicalTypeMessage =
  'Call ioda_search_entities with entityType country, region, asn, or geoasn; case and surrounding whitespace are accepted.';
const lexicalCodeMessage =
  'Use two country letters, decimal region digits, an optionally AS-prefixed ASN, or an ASN joined by a hyphen to region digits or two country letters; call ioda_search_entities to resolve a code.';
function lexicalFailure(result: Result, name: string, field: string, message: string) {
  const error = failure(result, JsonRpcErrorCode.InvalidParams, 'invalid_arguments');
  expect(error.message).toBe(
    `Input validation error: Invalid arguments for tool ${name}: ${field}: ${message}`,
  );
  expect(error.data?.recovery?.hint).toBe(`${field}: ${message}`);
  expect(text(result)).toContain(`Error: ${error.message}`);
  return error;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  calls.length = 0;
});

describe('normalized transport compatibility', () => {
  it.each([
    [
      { entityType: ' ASN ', entityCode: 123 },
      { entityType: 'asn', entityCode: '123' },
    ],
    [
      { entityType: ' ASN ', entityCode: ` aS${'0'.repeat(5000)}123 ` },
      { entityType: 'asn', entityCode: '123' },
    ],
    [
      { entityType: ' GeoASN ', entityCode: ` AS${'0'.repeat(5000)}123-ir ` },
      { entityType: 'geoasn', entityCode: '123-IR' },
    ],
    [
      {
        entityType: 'country',
        entityCode: '\uFEFF\t',
        query: ' '.repeat(5000),
        relatedToType: '\n',
        relatedToCode: '\r',
      },
      { entityType: 'country' },
    ],
    [
      { entityType: 'country', query: `\uFEFF${'😀'.repeat(100)}\u2028` },
      { entityType: 'country', query: '😀'.repeat(100) },
    ],
  ])('preserves normalized successful transport input %j', async (input, expected) => {
    network(() => envelope([]));
    // @ts-expect-error Transport callers can send numeric codes; framework parsing repairs them.
    const result = await runToolContract(searchEntities, input);
    const data = parity(result);
    expect(data.applied).toEqual({ ...expected, limit: 20, page: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('entityType')).toBe(expected.entityType);
    expect(calls[0]?.searchParams.get('entityCode')).toBe(
      'entityCode' in expected ? expected.entityCode : null,
    );
    expect(calls[0]?.searchParams.get('search')).toBe('query' in expected ? expected.query : null);
  });
});

describe('advertised lexical input patterns', () => {
  const definitions = [
    searchEntities,
    getStatus,
    findOutages,
    summarizeOutages,
    getSignals,
    getAlerts,
  ];
  it('advertises independently executable patterns on every lexical field', () => {
    for (const definition of definitions) {
      const schema = z.toJSONSchema(definition.input);
      const properties = schema.properties as Record<string, { pattern?: string }>;
      for (const field of [
        'entityType',
        'entityCode',
        'relatedToType',
        'relatedToCode',
        'source',
        'query',
      ]) {
        if (!properties[field]) continue;
        const pattern = properties[field].pattern;
        expect(pattern, `${definition.name}.${field}`).toBeTypeOf('string');
        const regex = new RegExp(pattern ?? '');
        const cases: [string, boolean][] =
          field === 'query'
            ? [
                [` ${'a'.repeat(200)} `, true],
                [' '.repeat(5000), true],
                ['😀'.repeat(100), true],
                ['😀'.repeat(101), false],
                ['a'.repeat(201), false],
              ]
            : field.endsWith('Type')
              ? [
                  [' CoUnTrY ', true],
                  [' GEOASN ', true],
                  ['planet', false],
                  ['country\nx', false],
                ]
              : field.endsWith('Code')
                ? [
                    [' us ', true],
                    [`aS${'0'.repeat(5000)}123-ir`, true],
                    ['0', true],
                    ['USA', false],
                    ['40934-USA', false],
                    ['12\n3', false],
                  ]
                : [
                    [' BGP ', true],
                    ['ping-SLASH24', true],
                    ['merit-NT', true],
                    ['ucsd-nt', false],
                    ['gtr', definition.name !== 'ioda_get_signals'],
                  ];
        for (const [value, valid] of cases)
          expect(regex.test(value), `${definition.name}.${field}: ${value.length}`).toBe(valid);
        const required = schema.required?.includes(field) ?? false;
        if (field !== 'query')
          expect(regex.test(' \n\t'), `${definition.name}.${field} blank`).toBe(!required);
      }
    }
  });
  it.each([
    [searchEntities, { entityType: 'planet' }, 'entityType', lexicalTypeMessage],
    [
      searchEntities,
      { entityType: ' GeoASN ', entityCode: ` AS${'0'.repeat(5000)}123-000IR ` },
      'entityCode',
      lexicalCodeMessage,
    ],
    [
      summarizeOutages,
      { ...window, entityType: 'region', relatedToType: 'continent', relatedToCode: 'EU' },
      'relatedToType',
      lexicalTypeMessage,
    ],
    [getStatus, { entityType: ' ', entityCode: 'US' }, 'entityType', lexicalTypeMessage],
    [
      getSignals,
      { ...window, entityType: 'asn', entityCode: '\t', source: 'bgp' },
      'entityCode',
      lexicalCodeMessage,
    ],
    [
      findOutages,
      { ...window, entityType: 'region', relatedToType: 'planet', relatedToCode: 'IR' },
      'relatedToType',
      lexicalTypeMessage,
    ],
    [
      getAlerts,
      { ...window, entityType: 'asn', relatedToType: 'geoasn', relatedToCode: '1-USA' },
      'relatedToCode',
      lexicalCodeMessage,
    ],
    [
      summarizeOutages,
      { ...window, entityType: 'country', entityCode: 'USA' },
      'entityCode',
      lexicalCodeMessage,
    ],
    [
      searchEntities,
      { entityType: 'country', query: '😀'.repeat(101) },
      'query',
      'Use a query of at most 200 UTF-16 code units after trimming, or omit query to list the entity type with ioda_search_entities.',
    ],
  ] as const)(
    'rejects lexical fields through both surfaces before HTTP: %s %s',
    async (definition, input, field, message) => {
      network(() => envelope([]));
      const result = await runToolContract(definition, input);
      expect(calls).toHaveLength(0);
      lexicalFailure(result, definition.name, field, message);
    },
  );
  it.each([
    [{ entityType: 'country', entityCode: '123' }, 'invalid_entity'],
    [{ entityType: 'region', entityCode: 'AS123' }, 'invalid_entity'],
    [{ entityType: 'asn', entityCode: '4294967296' }, 'invalid_entity'],
    [{ entityType: 'geoasn', entityCode: '0-IR' }, 'invalid_entity'],
    [{ entityType: 'asn', relatedToType: 'country', relatedToCode: '123' }, 'invalid_scope'],
    [{ entityType: 'asn', relatedToType: 'country' }, 'invalid_scope'],
    [{ entityType: 'country', entityCode: 'IR', query: 'Iran' }, 'conflicting_search'],
  ] as const)('keeps semantic reason %s after lexical validation', async (input, reason) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(searchEntities, input);
    const error = failure(result, JsonRpcErrorCode.ValidationError, reason);
    expect(text(result)).toContain(`Error: ${error.message}`);
    expect(calls).toHaveLength(0);
  });

  /** Fastest thread CPU of three ten-match batches after compiling the emitted pattern. */
  function patternCpu(pattern: string, input: string) {
    const regex = new RegExp(pattern);
    regex.test(input);
    let fastestUs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = process.threadCpuUsage();
      for (let match = 0; match < 10; match++) regex.test(input);
      const used = process.threadCpuUsage(start);
      fastestUs = Math.min(fastestUs, used.user + used.system);
    }
    return fastestUs;
  }
  it.each([
    ['digits', 5000, (n: number) => '0'.repeat(n)],
    ['digit suffix failure', 1250, (n: number) => `${'0'.repeat(n)}-`],
    ['geoasn area suffix failure', 1250, (n: number) => `AS${'0'.repeat(n)}-${'0'.repeat(n)}!`],
    ['query interior padding', 1250, (n: number) => `x${' '.repeat(n)}y`],
    ['padding before failure', 1250, (n: number) => `${' '.repeat(n)}${'a'.repeat(201)}`],
    ['long line ending in a break', 1250, (n: number) => `${'x'.repeat(n)}\ny`],
    ['breaks throughout', 1250, (n: number) => `${' \r\n'.repeat(n)}x`],
    ['blank padding', 1250, (n: number) => ' '.repeat(n)],
  ])('lexical pattern CPU growth stays linear for %s over 64× input', (_, start, shape) => {
    const patterns = new Set<string>();
    for (const definition of definitions) {
      const properties = z.toJSONSchema(definition.input).properties as Record<
        string,
        { pattern?: string; items?: { pattern?: string } }
      >;
      for (const property of Object.values(properties)) {
        if (property.pattern) patterns.add(property.pattern);
        if (property.items?.pattern) patterns.add(property.items.pattern);
      }
    }
    for (const pattern of patterns) {
      const samples: number[] = [];
      for (let size = start; size <= start * 64; size *= 2) {
        const cpuUs = patternCpu(pattern, shape(size));
        expect(cpuUs, `${pattern} at ${size}`).toBeLessThan(250_000);
        samples.push(cpuUs);
      }
      expect(samples).toHaveLength(7);
      expect((samples[6] ?? 0) / Math.max(samples[0] ?? 0, 1), pattern).toBeLessThan(256);
    }
  });
});
afterEach(() => {
  disposeIodaService();
  vi.useRealTimers();
});

describe('assembled contract parity', () => {
  it('preserves hostile nested entity data and all full-page enrichment', async () => {
    network(() => envelope([entity]));
    const result = await runToolContract(searchEntities, {
      entityType: ' CoUnTrY ',
      query: ' US ',
      entityCode: '  ',
      limit: 1,
      page: 1,
    });
    const data = parity(result);
    expect(data.entities).toEqual([entity]);
    expect(data.applied).toEqual({ entityType: 'country', query: 'US', limit: 1, page: 1 });
    expect(data.truncated).toEqual({ shown: 1, cap: 1 });
    expect(data.notice).toMatch(/nextPage/);
    expect(data.pagination).toEqual({
      page: 1,
      limit: 1,
      returned: 1,
      more: 'possible',
      nextPage: 2,
    });
    expect(calls[0]?.searchParams.get('search')).toBe('US');
  });
  it('preserves extended events, clipped ends, and nested alert unknown fields', async () => {
    network(() => envelope([event]));
    const data = parity(
      await runToolContract(findOutages, {
        ...window,
        entityType: ' COUNTRY ',
        entityCode: ' us ',
        source: ' BGP ',
        includeAlerts: true,
        limit: 1,
      }),
    );
    expect(data.events).toEqual([event]);
    expect(data.applied).toMatchObject({
      ...entityInput,
      source: 'bgp',
      includeAlerts: true,
      extendWindowSeconds: 1209600,
      format: 'ioda',
      overall: false,
      page: 0,
    });
    expect(calls[0]?.searchParams.get('datasource')).toBe('bgp');
    expect(calls[0]?.searchParams.get('includeAlerts')).toBe('true');
  });
  it('retains literal recovery-only alerts, zero and null baselines', async () => {
    network(() => envelope([alert]));
    const data = parity(
      await runToolContract(getAlerts, {
        ...window,
        source: ' GTR ',
        entityType: ' ',
        entityCode: '',
        limit: 1,
      }),
    );
    expect(data.alerts).toEqual([alert]);
    expect(data.applied).toMatchObject({ scope: 'global', source: 'gtr', extendWindowSeconds: 0 });
    expect(calls[0]?.searchParams.has('entityType')).toBe(false);
  });
  it('preserves every aligned bucket and subtype even beyond requested maxPoints', async () => {
    const series = ['one', 'two'].map((subtype) => ({
      entityType: 'asn',
      entityCode: '123',
      datasource: 'merit-nt',
      subtype,
      from: window.from - 300,
      until: window.from + 600,
      step: 300,
      nativeStep: 300,
      values: [null, 0, 4],
      extra: { text: hostile },
    }));
    network(() => envelope([series]));
    const data = parity(
      await runToolContract(getSignals, {
        ...window,
        entityType: ' ASN ',
        entityCode: ' AS000123 ',
        source: ' MERIT-NT ',
        maxPoints: 2,
      }),
    );
    expect(data.series).toEqual(series);
    expect(data.applied).toEqual({
      ...window,
      entityType: 'asn',
      entityCode: '123',
      source: 'merit-nt',
      maxPoints: 2,
    });
    expect(calls[0]?.pathname).toBe('/v2/signals/raw/asn/123');
    expect(data.semantics).toMatchObject({ source: 'merit-nt' });
  });
  it.each([0, 1, 999])(
    'renders empty resolver page %i with defaults and actionable continuation',
    async (page) => {
      network(() => envelope([]));
      const data = parity(
        await runToolContract(searchEntities, { entityType: 'region', query: ' ', page }),
      );
      expect(data.entities).toEqual([]);
      expect(data.applied).toEqual({ entityType: 'region', limit: 20, page });
      expect(data.pagination).toEqual({ page, limit: 20, returned: 0, more: 'no' });
      expect(data.notice).toMatch(page ? /page 0/ : /^IODA lists no region entities\.$/);
      expect(data.truncated).toBeUndefined();
    },
  );
  it('renders empty event, alert and numeric responses without an all-clear', async () => {
    network(() => envelope([]));
    let data = parity(await runToolContract(findOutages, { ...window }));
    expect(data.notice).toMatch(/not an all-clear/);
    network(() => envelope([]));
    data = parity(await runToolContract(getAlerts, { ...window, page: 3 }));
    expect(data.notice).toMatch(/page 0/);
    network(() => envelope([[]]));
    data = parity(await runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp' }));
    expect(data.notice).toMatch(/does not establish healthy/);
    expect(data.applied).toMatchObject({ maxPoints: 200 });
  });
  it('renders a full 100-record page without inventing a total', async () => {
    network(() =>
      envelope(
        Array.from({ length: 100 }, (_, index) => ({ code: String(index), name: 'region' })),
      ),
    );
    const data = parity(
      await runToolContract(searchEntities, { entityType: 'region', limit: 100 }),
    );
    expect(data.truncated).toEqual({ shown: 100, cap: 100 });
    expect(data.pagination).not.toHaveProperty('total');
  });
});

describe('served caps', () => {
  const nextPage =
    'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.';
  const query = (url: URL | undefined) => Object.fromEntries(url?.searchParams ?? []);
  const seconds = { from: String(window.from), until: String(window.until) };
  it('serves every input accepted before the caps with an unchanged request, applied and enrichment', async () => {
    network(() =>
      envelope(Array.from({ length: 100 }, (_, index) => ({ code: String(index), name: 'r' }))),
    );
    let data = parity(await runToolContract(searchEntities, { entityType: 'region', limit: 100 }));
    expect(query(calls[0])).toEqual({ entityType: 'region', limit: '100', page: '0' });
    expect(data.applied).toEqual({ entityType: 'region', limit: 100, page: 0 });
    expect(data.notice).toBe(nextPage);
    expect(data.truncated).toEqual({ shown: 100, cap: 100 });

    calls.length = 0;
    network(() => envelope([]));
    data = parity(
      await runToolContract(searchEntities, { entityType: 'country', entityCode: 'zz' }),
    );
    expect(query(calls[0])).toEqual({
      entityType: 'country',
      entityCode: 'ZZ',
      limit: '20',
      page: '0',
    });
    expect(data.applied).toEqual({ entityType: 'country', entityCode: 'ZZ', limit: 20, page: 0 });
    expect(data.notice).toBe(
      'IODA lists no country with entityCode ZZ. Call ioda_search_entities with entityType country and the name as query to find its code.',
    );
    expect(data.truncated).toBeUndefined();

    calls.length = 0;
    network(() => envelope([]));
    data = parity(
      await runToolContract(findOutages, {
        ...window,
        ...entityInput,
        limit: 100,
        extendWindowSeconds: 1209600,
      }),
    );
    expect(query(calls[0])).toEqual({
      ...seconds,
      ...entityInput,
      includeAlerts: 'false',
      extendWindow: '1209600',
      format: 'ioda',
      overall: 'false',
      limit: '100',
      page: '0',
    });
    expect(data.applied).toEqual({
      ...window,
      ...entityInput,
      includeAlerts: false,
      extendWindowSeconds: 1209600,
      limit: 100,
      page: 0,
      scope: 'entity',
      source: 'all',
      format: 'ioda',
      overall: false,
    });
    expect(data.notice).toBe(
      'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear. IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.',
    );

    calls.length = 0;
    network(() => envelope([]));
    data = parity(await runToolContract(findOutages, { ...window, entityType: 'asn', page: 2 }));
    expect(query(calls[0])).toMatchObject({ extendWindow: '1209600', limit: '20', page: '2' });
    expect(data.applied).toMatchObject({ extendWindowSeconds: 1209600, limit: 20, page: 2 });
    expect(data.notice).toBe(
      'This page is empty. Call ioda_find_outages with page 0 and unchanged filters, or return to the previous page.',
    );

    calls.length = 0;
    const slim = { entity: { code: 'US', name: 'US' }, datasource: 'bgp', time: window.from };
    network(() => envelope(Array.from({ length: 100 }, () => slim)));
    data = parity(
      await runToolContract(getAlerts, { ...window, limit: 100, extendWindowSeconds: 1209600 }),
    );
    expect(query(calls[0])).toEqual({
      ...seconds,
      extendWindow: '1209600',
      limit: '100',
      page: '0',
    });
    expect(data.applied).toEqual({
      ...window,
      extendWindowSeconds: 1209600,
      limit: 100,
      page: 0,
      scope: 'global',
      source: 'all',
    });
    expect(data.notice).toBe(nextPage);
    expect(data.truncated).toEqual({ shown: 100, cap: 100 });

    calls.length = 0;
    network(() => envelope([[]]));
    data = parity(
      await runToolContract(getSignals, {
        ...window,
        ...entityInput,
        source: 'bgp',
        maxPoints: 2000,
      }),
    );
    expect(query(calls[0])).toEqual({ ...seconds, datasource: 'bgp', maxPoints: '2000' });
    expect(data.applied).toEqual({ ...window, ...entityInput, source: 'bgp', maxPoints: 2000 });
    expect(data.notice).toBe(
      'No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source or an earlier window. Missing data does not establish healthy connectivity.',
    );

    calls.length = 0;
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 24 });
    await vi.advanceTimersByTimeAsync(9000);
    data = parity(await pending);
    expect(calls).toHaveLength(5);
    expect(calls.map((url) => url.searchParams.get('from'))).toEqual(
      Array(5).fill(String(now / 1000 - 86400)),
    );
    expect(data.applied).toMatchObject({
      ...entityInput,
      asOf: now / 1000,
      lookbackHours: 24,
      from: now / 1000 - 86400,
      until: now / 1000,
    });
    expect(data.notice).toBeUndefined();
  });
  it('serves each over-cap value at its cap and names requested, served and the route to the rest', () => {
    const asOf = now / 1000;
    expect(SERVED_CAPS).toStrictEqual({
      limit: 100,
      maxPoints: 2000,
      lookbackHours: 24,
      extendWindowSeconds: 1209600,
    });
    expect(clampLimit(100, 5)).toStrictEqual({ value: 100 });
    expect(clampLimit(101, 0)).toStrictEqual({
      value: 100,
      notice:
        'limit 101 exceeds the cap of 100; served 100. Every limit from 100 to 1000 serves the same pages.',
    });
    expect(clampLimit(1000, 2)).toStrictEqual({
      value: 100,
      notice:
        'limit 1000 exceeds the cap of 100; served 100. Page 2 starts after the first 200 records. Every limit from 100 to 1000 serves the same pages.',
    });
    expect(clampMaxPoints(2000)).toStrictEqual({ value: 2000 });
    expect(clampMaxPoints(2001)).toStrictEqual({
      value: 2000,
      notice:
        'maxPoints 2001 exceeds the cap of 2000; served 2000. For finer buckets, split the window into adjacent ioda_get_signals calls; a bucket that straddles the split point is returned by both calls.',
    });
    expect(clampLookbackHours(24, asOf)).toStrictEqual({ value: 24 });
    expect(clampLookbackHours(240, asOf)).toStrictEqual({
      value: 24,
      notice:
        'lookbackHours 240 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from 1791676800 and until 1792454400.',
    });
    expect(clampExtendWindow(0, 'ioda_find_outages', window, now)).toStrictEqual({ value: 0 });
    expect(clampExtendWindow(1209600, 'ioda_find_outages', window, now)).toStrictEqual({
      value: 1209600,
    });
  });
  describe('over-cap extension tails', () => {
    const served = (requested: number) =>
      `extendWindowSeconds ${requested} exceeds the cap of 1209600; served 1209600.`;
    const nowSeconds = now / 1000;
    /** A one-hour window ending 2,000,000 seconds before now, so until + 1209600 is still past. */
    const old = { from: nowSeconds - 2003600, until: nowSeconds - 2000000 };
    const month = { from: nowSeconds - 2678400, until: nowSeconds };
    const tails = [
      [
        'events: from moves back by the uncovered 790400 seconds, until kept',
        'ioda_find_outages',
        2000000,
        window,
        'An event overlapping the window that began more than 1209600 seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with from 1791746800, until 1792540800, extendWindowSeconds 1209600, and the other filters unchanged, then keep only the events whose until is at or after 1792537200.',
      ],
      [
        'events over a full 31-day window: until moves back too, staying after from',
        'ioda_find_outages',
        12096000,
        month,
        'An event overlapping the window that began more than 1209600 seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with from 1787184001, until 1789862401, extendWindowSeconds 1209600, and the other filters unchanged, then keep only the events whose until is at or after 1789862400.',
      ],
      [
        'alerts ending within 1209600 seconds of now: only the earlier side',
        'ioda_get_alerts',
        1209601,
        window,
        'Transitions more than 1209600 seconds before from are not returned. To reach them, call ioda_get_alerts at page 0 with from 1792537199, until 1792540800, extendWindowSeconds 1209600, and the other filters unchanged.',
      ],
      [
        'alerts ending more than 1209600 seconds before now: both sides',
        'ioda_get_alerts',
        2000000,
        old,
        'Transitions more than 1209600 seconds before from or after until are not returned. To reach the earlier ones, call ioda_get_alerts at page 0 with from 1789746800, until 1790540800, extendWindowSeconds 1209600, and the other filters unchanged; for the later ones, use from 1790537200 and until 1791331200 instead.',
      ],
      [
        'alerts whose later side reaches now: until stops at now',
        'ioda_get_alerts',
        12096000,
        old,
        'Transitions more than 1209600 seconds before from or after until are not returned. To reach the earlier ones, call ioda_get_alerts at page 0 with from 1787858801, until 1790537201, extendWindowSeconds 1209600, and the other filters unchanged; for the later ones, use from 1790537200 and until 1792540800 instead.',
      ],
      [
        'summaries: no ranking recipe, one entity through ioda_find_outages',
        'ioda_summarize_outages',
        2000000,
        window,
        "Events overlapping the window that began more than 1209600 seconds before from are not counted, or are counted from a later start. To check one entity for such an event, call ioda_find_outages with this entityType, that entity's code as entityCode, from 1791746800, until 1792540800, and extendWindowSeconds 1209600, then keep only the events whose until is at or after 1792537200.",
      ],
    ] as const;
    it.each(tails)('%s', (_, tool, requested, bounds, tail) => {
      expect(clampExtendWindow(requested, tool, bounds, now)).toStrictEqual({
        value: 1209600,
        notice: `${served(requested)} ${tail}`,
      });
    });
    /** The whole notice of an empty first page for an entityCode: no served-cap disclosure. */
    const unclamped = {
      ioda_find_outages:
        'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear. IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.',
      ioda_get_alerts:
        'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations. IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.',
    };
    it.each(tails)(
      'prints windows that validate and serve unclamped: %s',
      async (_, tool, requested, bounds) => {
        const notice = clampExtendWindow(requested, tool, bounds, now).notice ?? '';
        const recipes = [...notice.matchAll(/from (\d+)(?:,| and) until (\d+)/g)];
        expect(recipes.length).toBe(tool === 'ioda_get_alerts' && bounds === old ? 2 : 1);
        const recipeTool = tool === 'ioda_get_alerts' ? tool : 'ioda_find_outages';
        for (const [, from, until] of recipes) {
          calls.length = 0;
          network(() => envelope([]));
          const data = parity(
            await runToolContract(recipeTool === 'ioda_get_alerts' ? getAlerts : findOutages, {
              entityType: 'country',
              entityCode: 'IR',
              from: Number(from),
              until: Number(until),
              extendWindowSeconds: 1209600,
            }),
          );
          expect(calls).toHaveLength(1);
          expect(query(calls[0])).toMatchObject({ from, until, extendWindow: '1209600' });
          expect(Number(until) - Number(from)).toBeLessThanOrEqual(2678400);
          expect(Number(until)).toBeGreaterThan(bounds.from);
          expect(data.applied).toMatchObject({
            from: Number(from),
            until: Number(until),
            extendWindowSeconds: 1209600,
          });
          expect(data.notice).toBe(unclamped[recipeTool]);
        }
      },
    );
  });
  it('composes notice parts in order and closes a continuable full page with the next-page continuation', () => {
    const applied = { limit: 100 };
    const full = { page: 3, limit: 100, returned: 100, more: 'possible', nextPage: 4 } as const;
    const short = { page: 0, limit: 100, returned: 7, more: 'no' } as const;
    const final = { page: 0, limit: 100, returned: 100, more: 'possible' } as const;
    expect(composeEnrichment(applied, ['Narrow it.'], final)).toStrictEqual({
      applied,
      notice: 'Narrow it.',
      truncated: { shown: 100, cap: 100 },
    });
    expect(composeEnrichment(applied, [])).toStrictEqual({ applied });
    expect(composeEnrichment(applied, [undefined, false, ''], short)).toStrictEqual({ applied });
    expect(composeEnrichment(applied, ['First.', false, undefined, 'Second.'])).toStrictEqual({
      applied,
      notice: 'First. Second.',
    });
    expect(composeEnrichment(applied, ['Only.'], short)).toStrictEqual({
      applied,
      notice: 'Only.',
    });
    expect(composeEnrichment(applied, [], full)).toStrictEqual({
      applied,
      notice: nextPage,
      truncated: { shown: 100, cap: 100 },
    });
    expect(composeEnrichment(applied, ['First.', 'Second.'], full)).toStrictEqual({
      applied,
      notice: `First. Second. ${nextPage}`,
      truncated: { shown: 100, cap: 100 },
    });
  });
  it('serves an over-cap search limit and composes its notice with the next page', async () => {
    network(() =>
      envelope(Array.from({ length: 100 }, (_, index) => ({ code: String(index), name: 'r' }))),
    );
    const data = parity(
      await runToolContract(searchEntities, { entityType: 'region', limit: 150, page: 1 }),
    );
    expect(query(calls[0])).toEqual({ entityType: 'region', limit: '100', page: '1' });
    expect(data.applied).toEqual({ entityType: 'region', limit: 100, page: 1 });
    expect(data.pagination).toEqual({
      page: 1,
      limit: 100,
      returned: 100,
      more: 'possible',
      nextPage: 2,
    });
    expect(data.truncated).toEqual({ shown: 100, cap: 100 });
    expect(data.notice).toBe(
      `limit 150 exceeds the cap of 100; served 100. Page 1 starts after the first 100 records. Every limit from 100 to 1000 serves the same pages. ${nextPage}`,
    );
  });
  it('serves over-cap event limit and extension and composes them with the empty-page notice', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(findOutages, {
        ...window,
        ...entityInput,
        limit: 1000,
        extendWindowSeconds: 12096000,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '100', extendWindow: '1209600', page: '0' });
    expect(data.applied).toMatchObject({ limit: 100, extendWindowSeconds: 1209600 });
    expect(data.pagination).toEqual({ page: 0, limit: 100, returned: 0, more: 'no' });
    expect(data.truncated).toBeUndefined();
    expect(data.notice).toBe(
      'limit 1000 exceeds the cap of 100; served 100. Every limit from 100 to 1000 serves the same pages. extendWindowSeconds 12096000 exceeds the cap of 1209600; served 1209600. An event overlapping the window that began more than 1209600 seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with from 1789858801, until 1792537201, extendWindowSeconds 1209600, and the other filters unchanged, then keep only the events whose until is at or after 1792537200. No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear. IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.',
    );
  });
  it('serves over-cap alert limit and extension on a past-end page', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(getAlerts, {
        ...window,
        limit: 101,
        extendWindowSeconds: 1209601,
        page: 3,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '100', extendWindow: '1209600', page: '3' });
    expect(data.applied).toMatchObject({ limit: 100, extendWindowSeconds: 1209600, page: 3 });
    expect(data.pagination).toEqual({ page: 3, limit: 100, returned: 0, more: 'no' });
    expect(data.notice).toBe(
      'limit 101 exceeds the cap of 100; served 100. Page 3 starts after the first 300 records. Every limit from 100 to 1000 serves the same pages. extendWindowSeconds 1209601 exceeds the cap of 1209600; served 1209600. Transitions more than 1209600 seconds before from are not returned. To reach them, call ioda_get_alerts at page 0 with from 1792537199, until 1792540800, extendWindowSeconds 1209600, and the other filters unchanged. This page is empty. Call ioda_get_alerts with page 0 and unchanged filters, or return to the previous page.',
    );
  });
  it('keeps a transition after until and routes both sides of an older over-cap alert window', async () => {
    const old = { from: window.from - 2000000, until: window.until - 2000000 };
    const later = { ...alert, time: old.until + 600 };
    network(() => envelope([later]));
    const data = parity(
      await runToolContract(getAlerts, { ...old, ...entityInput, extendWindowSeconds: 2000000 }),
    );
    expect(query(calls[0])).toMatchObject({
      from: String(old.from),
      until: String(old.until),
      extendWindow: '1209600',
    });
    expect(data.alerts).toEqual([later]);
    expect(data.notice).toBe(
      'extendWindowSeconds 2000000 exceeds the cap of 1209600; served 1209600. Transitions more than 1209600 seconds before from or after until are not returned. To reach the earlier ones, call ioda_get_alerts at page 0 with from 1789746800, until 1790540800, extendWindowSeconds 1209600, and the other filters unchanged; for the later ones, use from 1790537200 and until 1791331200 instead.',
    );
  });
  it('serves over-cap maxPoints at 2000 alone and composed with the empty-series notice', async () => {
    const series = {
      entityType: 'country',
      entityCode: 'US',
      datasource: 'bgp',
      from: window.from,
      until: window.until,
      step: 1800,
      nativeStep: 300,
      values: [1, null],
    };
    const clamp =
      'maxPoints 20000 exceeds the cap of 2000; served 2000. For finer buckets, split the window into adjacent ioda_get_signals calls; a bucket that straddles the split point is returned by both calls.';
    network(() => envelope([[series]]));
    const input = { ...window, ...entityInput, source: 'bgp', maxPoints: 20000 };
    let data = parity(await runToolContract(getSignals, input));
    expect(query(calls[0])).toEqual({ ...seconds, datasource: 'bgp', maxPoints: '2000' });
    expect(data.applied).toEqual({ ...window, ...entityInput, source: 'bgp', maxPoints: 2000 });
    expect(data.series).toEqual([series]);
    expect(data.notice).toBe(
      `${clamp} Coarse series aggregate underlying samples, so values need not equal an unweighted mean of finer returned buckets; a non-null aggregate cannot establish complete finer-resolution coverage. Request a narrower window with ioda_get_signals to inspect finer observations.`,
    );
    network(() => envelope([[]]));
    data = parity(await runToolContract(getSignals, input));
    expect(data.notice).toBe(
      `${clamp} No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source or an earlier window. Missing data does not establish healthy connectivity.`,
    );
  });
  it('serves an over-cap lookback as 24 hours and composes it with incomplete evidence', async () => {
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    let pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 240 });
    await vi.advanceTimersByTimeAsync(9000);
    let data = parity(await pending);
    expect(calls).toHaveLength(5);
    expect(calls.map((url) => url.searchParams.get('from'))).toEqual(
      Array(5).fill(String(now / 1000 - 86400)),
    );
    expect(data.window).toEqual({ from: now / 1000 - 86400, until: now / 1000 });
    expect(data.applied).toMatchObject({ lookbackHours: 24, from: now / 1000 - 86400 });
    expect(data.notice).toBe(
      'lookbackHours 240 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from 1791676800 and until 1792454400.',
    );
    vi.setSystemTime(now);
    network((url) =>
      url.searchParams.get('datasource') === 'bgp'
        ? new Response('', { status: 422 })
        : envelope(url.pathname.includes('/signals/') ? [[]] : []),
    );
    pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 25 });
    await vi.advanceTimersByTimeAsync(9000);
    data = parity(await pending);
    expect(data.notice).toBe(
      'lookbackHours 25 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from 1792450800 and until 1792454400. Evidence is incomplete. Follow each failed component recovery with its standalone tool; missing evidence does not establish healthy connectivity.',
    );
  });
  const signal = { ...window, ...entityInput, source: 'bgp' };
  it.each([
    [
      'limit: Too small: expected number to be >=1',
      () => runToolContract(searchEntities, { entityType: 'region', limit: 0 }),
    ],
    [
      'limit: Too big: expected number to be <=1000',
      () => runToolContract(searchEntities, { entityType: 'region', limit: 1001 }),
    ],
    [
      'limit: Too big: expected number to be <=1000',
      () => runToolContract(findOutages, { ...window, limit: 1001 }),
    ],
    [
      'limit: Too big: expected number to be <=1000',
      () => runToolContract(getAlerts, { ...window, limit: 1001 }),
    ],
    [
      'maxPoints: Too small: expected number to be >=1',
      () => runToolContract(getSignals, { ...signal, maxPoints: 0 }),
    ],
    [
      'maxPoints: Too big: expected number to be <=20000',
      () => runToolContract(getSignals, { ...signal, maxPoints: 20001 }),
    ],
    [
      'lookbackHours: Too small: expected number to be >=1',
      () => runToolContract(getStatus, { ...entityInput, lookbackHours: 0 }),
    ],
    [
      'lookbackHours: Too big: expected number to be <=240',
      () => runToolContract(getStatus, { ...entityInput, lookbackHours: 241 }),
    ],
    [
      'extendWindowSeconds: Too small: expected number to be >=0',
      () => runToolContract(findOutages, { ...window, extendWindowSeconds: -1 }),
    ],
    [
      'extendWindowSeconds: Too big: expected number to be <=12096000',
      () => runToolContract(findOutages, { ...window, extendWindowSeconds: 12096001 }),
    ],
    [
      'extendWindowSeconds: Too big: expected number to be <=12096000',
      () => runToolContract(getAlerts, { ...window, extendWindowSeconds: 12096001 }),
    ],
  ])('still rejects outside the schema bounds before HTTP: %s', async (bound, run) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const error = failure(await run(), JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message.endsWith(`: ${bound}`)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('event extension defaults by scope', () => {
  const query = (url: URL | undefined) => Object.fromEntries(url?.searchParams ?? []);
  const unscopedDefault =
    'extendWindowSeconds defaulted to 86400 (one day) for global scope, so events that began more than a day before from can be missing. Add entityType for the 14-day default, or pass extendWindowSeconds explicitly; large global extensions can time out.';
  const zeroHit =
    'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.';
  const nextPage =
    'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.';
  it('advertises both defaults and leaves an omitted extension unset until the handler resolves it', () => {
    expect(findOutages.input.parse(window).extendWindowSeconds).toBeUndefined();
    expect(findOutages.input.shape.extendWindowSeconds.description).toBe(
      'Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; only overlapping events are returned. Defaults to 1209600 (14 days) with entityType and 86400 (one day) without it, because large global extensions can time out; the applied value is echoed. Values above 1209600 are served as 1209600 with a notice. Zero may miss long-running detections.',
    );
    expect(getAlerts.input.parse(window).extendWindowSeconds).toBe(0);
    expect(getAlerts.input.shape.extendWindowSeconds.description).toBe(
      'Seconds before from and after until to also return transitions from; zero, the default, returns only transitions inside the window. Without entityType, large extensions are slow globally and can time out, so add entityType or keep the extension small. Values above 1209600 (14 days) are served as 1209600 with a notice.',
    );
    expect(summarizeOutages.input.shape.extendWindowSeconds.description).toBe(
      "Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; defaults to 1209600 (14 days), IODA's default. Values above 1209600 are served as 1209600 with a notice. Large extensions on type-only rankings can time out; zero may miss long-running detections.",
    );
  });
  it.each([
    ['no entity filters', {}],
    ['blank entity filters', { entityType: ' ', entityCode: '' }],
  ])(
    'resolves an omitted extension to 86400 for %s and composes its notice with the zero-hit notice',
    async (_, filters) => {
      network(() => envelope([]));
      const data = parity(await runToolContract(findOutages, { ...window, ...filters }));
      expect(calls).toHaveLength(1);
      expect(query(calls[0])).toEqual({
        from: String(window.from),
        until: String(window.until),
        includeAlerts: 'false',
        extendWindow: '86400',
        format: 'ioda',
        overall: 'false',
        limit: '20',
        page: '0',
      });
      expect(data.applied).toEqual({
        ...window,
        includeAlerts: false,
        extendWindowSeconds: 86400,
        limit: 20,
        page: 0,
        scope: 'global',
        source: 'all',
        format: 'ioda',
        overall: false,
      });
      expect(data.notice).toBe(`${unscopedDefault} ${zeroHit}`);
    },
  );
  it('composes the unscoped default notice with the next-page continuation and a past-end page', async () => {
    network(() => envelope([event]));
    let data = parity(await runToolContract(findOutages, { ...window, limit: 1 }));
    expect(calls[0]?.searchParams.get('extendWindow')).toBe('86400');
    expect(data.events).toEqual([event]);
    expect(data.truncated).toEqual({ shown: 1, cap: 1 });
    expect(data.notice).toBe(`${unscopedDefault} ${nextPage}`);
    network(() => envelope([]));
    data = parity(await runToolContract(findOutages, { ...window, limit: 1, page: 9 }));
    expect(calls[1]?.searchParams.get('extendWindow')).toBe('86400');
    expect(data.applied).toMatchObject({ extendWindowSeconds: 86400, page: 9 });
    expect(data.notice).toBe(
      `${unscopedDefault} This page is empty. Call ioda_find_outages with page 0 and unchanged filters, or return to the previous page.`,
    );
  });
  it.each([
    ['a type-only filter', { entityType: ' REGION ' }, zeroHit, 'entity'],
    [
      'an entity pair',
      entityInput,
      `${zeroHit} IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.`,
      'entity',
    ],
    [
      'a relatedTo scope',
      { entityType: 'region', relatedToType: 'country', relatedToCode: 'IR' },
      `${zeroHit} ${verifyScope}`,
      'related',
    ],
  ])(
    'keeps the 14-day default for %s without a default notice',
    async (_, filters, notice, scope) => {
      network(() => envelope([]));
      const data = parity(await runToolContract(findOutages, { ...window, ...filters }));
      expect(calls[0]?.searchParams.get('extendWindow')).toBe('1209600');
      expect(data.applied).toMatchObject({ extendWindowSeconds: 1209600, scope });
      expect(rowGuidance(data.notice)).toBe(notice);
    },
  );
  it.each([0, 3600, 86400, 604800, 1209600])(
    'honors an explicit global extension of %i unchanged without a default notice',
    async (extendWindowSeconds) => {
      network(() => envelope([]));
      const data = parity(await runToolContract(findOutages, { ...window, extendWindowSeconds }));
      expect(calls[0]?.searchParams.get('extendWindow')).toBe(String(extendWindowSeconds));
      expect(data.applied).toMatchObject({ extendWindowSeconds, scope: 'global' });
      expect(data.notice).toBe(zeroHit);
    },
  );
  it('serves an explicit over-cap global extension at the cap with only the cap notice', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(findOutages, { ...window, extendWindowSeconds: 1209601 }),
    );
    expect(calls[0]?.searchParams.get('extendWindow')).toBe('1209600');
    expect(data.applied).toMatchObject({ extendWindowSeconds: 1209600, scope: 'global' });
    expect(data.notice).toBe(
      `extendWindowSeconds 1209601 exceeds the cap of 1209600; served 1209600. An event overlapping the window that began more than 1209600 seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with from 1792537199, until 1792540800, extendWindowSeconds 1209600, and the other filters unchanged, then keep only the events whose until is at or after 1792537200. ${zeroHit}`,
    );
  });
});

describe('errors visible on both consumption paths', () => {
  const invocations = [
    { name: 'events', run: () => runToolContract(findOutages, window) },
    { name: 'alerts', run: () => runToolContract(getAlerts, window) },
    {
      name: 'summary',
      run: () => runToolContract(summarizeOutages, { ...window, entityType: 'country' }),
    },
    {
      name: 'signals',
      run: () => runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp' }),
    },
    { name: 'status', run: () => runToolContract(getStatus, entityInput) },
  ];
  for (const invocation of invocations) {
    it.each([
      [400, JsonRpcErrorCode.InvalidParams, 'upstream_bad_request'],
      [422, JsonRpcErrorCode.ValidationError, 'upstream_unprocessable'],
      [404, JsonRpcErrorCode.NotFound, 'entity_not_found'],
      [429, JsonRpcErrorCode.RateLimited, 'upstream_rate_limited'],
    ] as const)(
      `${invocation.name} preserves HTTP %i code, reason and recovery on both surfaces`,
      async (status, code, reason) => {
        network(() => new Response('private upstream text', { status }));
        const pending = invocation.run();
        if (invocation.name === 'status') await vi.advanceTimersByTimeAsync(9000);
        const result = await pending;
        failure(result, code, reason);
        expect(text(result)).not.toContain('private upstream text');
      },
    );
  }
  it.each(['gtr', 'ucsd-nt', ' ', ' GTR '])(
    'rejects unsupported numeric source %j with invalid_arguments before HTTP',
    async (source) => {
      network(() => {
        throw new Error('unexpected network');
      });
      const result = await runToolContract(getSignals, { ...window, ...entityInput, source });
      const error = lexicalFailure(
        result,
        'ioda_get_signals',
        'source',
        'Use source bgp, ping-slash24, or merit-nt; for gtr detections call ioda_find_outages or ioda_get_alerts with source gtr.',
      );
      expect(text(result)).toContain(`Error: ${error.message}`);
      expect(calls).toHaveLength(0);
    },
  );
  it('rejects an unsupported event or alert source with each tool recovery before HTTP', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const results = [
      ['ioda_find_outages', await runToolContract(findOutages, { ...window, source: 'ucsd-nt' })],
      ['ioda_get_alerts', await runToolContract(getAlerts, { ...window, source: 'ucsd-nt' })],
    ] as const;
    for (const [name, result] of results) {
      const error = lexicalFailure(
        result,
        name,
        'source',
        'Call ioda_find_outages or ioda_get_alerts with source bgp, ping-slash24, merit-nt, or gtr, or omit source to search all sources.',
      );
      expect(text(result)).toContain(`Error: ${error.message}`);
    }
    expect(calls).toHaveLength(0);
  });
  it('treats a blank event or alert source as all sources', async () => {
    for (const run of [
      () => runToolContract(findOutages, { ...window, source: ' ' }),
      () => runToolContract(getAlerts, { ...window, source: '' }),
    ]) {
      network(() => envelope([]));
      expect(parity(await run()).applied).toMatchObject({ source: 'all' });
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => !url.searchParams.has('datasource'))).toBe(true);
  });
  it('rejects a 201-character query with invalid_arguments and serves 200 after trimming', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(searchEntities, {
      entityType: 'country',
      query: 'a'.repeat(201),
    });
    const error = lexicalFailure(
      result,
      'ioda_search_entities',
      'query',
      'Use a query of at most 200 UTF-16 code units after trimming, or omit query to list the entity type with ioda_search_entities.',
    );
    expect(text(result)).toContain(`Error: ${error.message}`);
    expect(calls).toHaveLength(0);
    network(() => envelope([]));
    parity(
      await runToolContract(searchEntities, {
        entityType: 'country',
        query: ` ${'a'.repeat(200)} `,
      }),
    );
    expect(calls[0]?.searchParams.get('search')).toBe('a'.repeat(200));
  });
  it('accepts maximum numeric and historical window boundaries without locally capping buckets', async () => {
    network(() => envelope([[]]));
    const data = parity(
      await runToolContract(getSignals, {
        ...entityInput,
        source: 'bgp',
        from: window.until - 31 * 86400,
        until: window.until,
        maxPoints: 2000,
      }),
    );
    expect(data.applied).toMatchObject({ maxPoints: 2000, from: window.until - 31 * 86400 });
    expect(calls[0]?.searchParams.get('maxPoints')).toBe('2000');
  });
  it.each([400, 422, 200])(
    'resolver recovery for HTTP %i names search inputs without an impossible time window',
    async (status) => {
      network(() => (status === 200 ? envelope([{ code: 'US' }]) : new Response('', { status })));
      const result = await runToolContract(searchEntities, { entityType: 'country' });
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error;
      expect(error.data.recovery.hint).toMatch(/query|entityType|entityCode|limit/);
      expect(error.data.recovery.hint).not.toMatch(/window/i);
      expect(text(result)).toContain(error.data.recovery.hint);
    },
  );
  it.each([
    [400, JsonRpcErrorCode.InvalidParams, 'upstream_bad_request'],
    [422, JsonRpcErrorCode.ValidationError, 'upstream_unprocessable'],
    [404, JsonRpcErrorCode.NotFound, 'entity_not_found'],
    [429, JsonRpcErrorCode.RateLimited, 'upstream_rate_limited'],
  ] as const)('preserves HTTP %i reason and recovery', async (status, code, reason) => {
    network(
      () => new Response('private upstream text', { status, headers: { 'Retry-After': '17' } }),
    );
    failure(await runToolContract(searchEntities, { entityType: 'country' }), code, reason);
    expect(calls).toHaveLength(1);
  });
  it('rejects conflicting normalized search and malformed entity pairs before HTTP', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    failure(
      await runToolContract(searchEntities, {
        entityType: 'country',
        entityCode: 'us',
        query: ' US ',
      }),
      JsonRpcErrorCode.ValidationError,
      'conflicting_search',
    );
    lexicalFailure(
      await runToolContract(getStatus, { entityType: 'country', entityCode: 'USA' }),
      'ioda_get_status',
      'entityCode',
      lexicalCodeMessage,
    );
    failure(
      await runToolContract(findOutages, { ...window, entityCode: 'US' }),
      JsonRpcErrorCode.ValidationError,
      'invalid_entity',
    );
    expect(calls).toHaveLength(0);
  });
  it.each([
    [{ from: window.until, until: window.from }, 'from 1792540800 is not before until 1792537200.'],
    [{ from: window.from, until: window.until + 1 }, 'until 1792540801 is after now (1792540800).'],
    [{ from: window.from, until: 99999999999 }, 'until 99999999999 is after now (1792540800).'],
    [
      { from: window.until + 20, until: window.until + 10 },
      'from 1792540820 is not before until 1792540810.',
    ],
    [
      { from: window.until - 31 * 86400 - 1, until: window.until },
      'The window spans 2678401 seconds, over the 31-day limit of 2678400.',
    ],
    [
      { from: now - 3600000, until: now },
      'from 1792537200000 and until 1792540800000 look like milliseconds; pass Unix seconds (divide by 1000).',
    ],
    [
      { from: window.from, until: 100000000000 },
      'until 100000000000 looks like milliseconds; pass Unix seconds (divide by 1000).',
    ],
    [
      { from: now - 3600000, until: window.until },
      'from 1792537200000 looks like milliseconds; pass Unix seconds (divide by 1000).',
    ],
  ])('rejects invalid window %j with its rule and a concrete retry', async (input, message) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(getAlerts, input);
    const error = failure(result, JsonRpcErrorCode.ValidationError, 'invalid_window');
    expect(error.message).toBe(message);
    expect(error.data?.recovery?.hint).toBe(
      'Call ioda_get_alerts with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows; shared boundaries can duplicate detections.',
    );
    expect(text(result)).toContain(`Error: ${message}`);
    expect(calls).toHaveLength(0);
  });
  it.each([
    [
      'ioda_find_outages',
      () => runToolContract(findOutages, window),
      'Call ioda_find_outages with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.',
    ],
    [
      'ioda_get_alerts',
      () => runToolContract(getAlerts, window),
      'Call ioda_get_alerts with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.',
    ],
    [
      'ioda_get_signals',
      () => runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp' }),
      'Call ioda_get_signals with a narrower window or retry later after upstream collection timed out.',
    ],
    [
      'ioda_summarize_outages',
      () => runToolContract(summarizeOutages, { ...window, entityType: 'region' }),
      'Call ioda_summarize_outages with an entityCode or a relatedToType and relatedToCode scope, a narrower window, or a smaller extendWindowSeconds, or retry later after upstream collection timed out.',
    ],
  ] as const)(
    '%s reports an exchange that outlives the per-attempt timeout with its declared levers',
    async (_, run, hint) => {
      network(() => new Promise<never>(() => {}) as unknown as Response);
      const pending = run();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      const error = failure(result, JsonRpcErrorCode.Timeout, 'upstream_timeout');
      expect(error.message).toBe('IODA collection timed out.');
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(text(result)).toContain(`Recovery: ${hint}`);
      expect(calls).toHaveLength(1);
    },
  );
  it('declares the timeout contract on the event, alert and summary tools with the recovery the service sends', () => {
    for (const [name, definition] of [
      ['ioda_find_outages', findOutages],
      ['ioda_get_alerts', getAlerts],
      ['ioda_summarize_outages', summarizeOutages],
    ] as const) {
      expect(definition.name).toBe(name);
      const entries = (definition.errors ?? []).filter(
        (entry) => entry.reason === 'upstream_timeout',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        thrownBy: 'service',
        recovery: recoveryFor('upstream_timeout', name),
      });
    }
  });
  it('retains error-envelope and malformed-record reasons', async () => {
    network(() => Response.json({ error: 'private', data: [] }));
    failure(
      await runToolContract(getAlerts, window),
      JsonRpcErrorCode.InvalidParams,
      'upstream_bad_request',
    );
    network(() => envelope([{ code: 'US' }]));
    failure(
      await runToolContract(searchEntities, { entityType: 'country' }),
      JsonRpcErrorCode.SerializationError,
      'upstream_schema',
    );
  });
  /** The verified maxPoints=1 shape: two values covering 7200 seconds under step 300. */
  const inconsistent = {
    entityType: 'country',
    entityCode: 'US',
    datasource: 'bgp',
    from: window.from,
    until: window.from + 7200,
    step: 300,
    nativeStep: 300,
    values: [1, 2],
  };
  const narrower =
    'Call ioda_get_signals with a narrower window; the source bucket intervals were inconsistent.';
  it.each([
    [
      1,
      'Call ioda_get_signals with a larger maxPoints (up to 2000) or a narrower window; the source bucket intervals were inconsistent.',
    ],
    [
      1999,
      'Call ioda_get_signals with a larger maxPoints (up to 2000) or a narrower window; the source bucket intervals were inconsistent.',
    ],
    [2000, narrower],
    [20000, narrower],
  ])(
    'names maxPoints for inconsistent buckets only below the 2000 cap: %i',
    async (maxPoints, hint) => {
      network(() => envelope([[inconsistent]]));
      const result = await runToolContract(getSignals, {
        ...window,
        ...entityInput,
        source: 'bgp',
        maxPoints,
      });
      const error = failure(result, JsonRpcErrorCode.SerializationError, 'upstream_schema');
      expect(error.message).toBe('IODA returned inconsistent signal bucket bounds and step.');
      expect(error.data?.recovery?.hint).toBe(hint);
    },
  );
  it('routes an inconsistent status signal to a narrower ioda_get_signals window, not maxPoints', async () => {
    network((url) =>
      url.searchParams.get('datasource') === 'bgp'
        ? envelope([[inconsistent]])
        : envelope(url.pathname.includes('/signals/') ? [[]] : []),
    );
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 1 });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    const failed = (
      data.components as { component: string; failure?: { reason: string; recovery: string } }[]
    ).filter((component) => component.failure);
    expect(failed).toEqual([
      {
        component: 'bgp',
        state: 'failed',
        failure: {
          code: JsonRpcErrorCode.SerializationError,
          reason: 'upstream_schema',
          message: 'IODA returned inconsistent signal bucket bounds and step.',
          recovery: `${narrower} Use source bgp.`,
        },
      },
    ]);
  });
});

describe('status collection contract', () => {
  it('returns five successful empty components and a captured exact window', async () => {
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    const pending = runToolContract(getStatus, { entityType: ' country ', entityCode: 'us' });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    expect(data.asOf).toBe(now / 1000);
    expect(data.window).toEqual({ from: now / 1000 - 6 * 3600, until: now / 1000 });
    expect(data.detection).toBe('none_returned');
    expect(data.components).toHaveLength(5);
    expect(data.signals).toEqual(
      (['bgp', 'ping-slash24', 'merit-nt'] as const).map((source) => ({
        source,
        unit: units[source],
        coverage: 'no_data',
        series: [],
      })),
    );
    expect(data.applied).toMatchObject({ lookbackHours: 6, signals: { maxPoints: 2000 } });
    const extensions = calls
      .filter((url) => url.pathname.startsWith('/v2/outages/'))
      .map((url) => [url.pathname, url.searchParams.get('extendWindow')]);
    expect(extensions).toEqual([
      ['/v2/outages/events', '1209600'],
      ['/v2/outages/alerts', '0'],
    ]);
    expect(data.applied).toMatchObject({
      events: { extendWindowSeconds: 1209600 },
      alerts: { extendWindowSeconds: 0 },
    });
  });
  it('keeps partial HTTP failures explicit with standalone recovery', async () => {
    network((url) =>
      url.searchParams.get('datasource') === 'bgp'
        ? new Response('', { status: 422 })
        : envelope(
            url.pathname.includes('/signals/')
              ? [[]]
              : [event].filter(() => url.pathname.endsWith('/events')),
          ),
    );
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 1 });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    expect(data.detection).toBe('observed');
    expect(data.notice).toMatch(/incomplete/);
    expect(data.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'bgp',
          state: 'failed',
          failure: expect.objectContaining({
            reason: 'upstream_unprocessable',
            recovery: expect.stringMatching(/ioda_get_signals.*bgp/),
          }),
        }),
      ]),
    );
    expect(data.signals).toEqual([
      { source: 'bgp', unit: 'Visible /24s', coverage: 'unknown', series: [] },
      { source: 'ping-slash24', unit: 'Up /24s', coverage: 'no_data', series: [] },
      { source: 'merit-nt', unit: 'Unique Source IPs', coverage: 'no_data', series: [] },
    ]);
  });
  it('reports an all-component failure as an error', async () => {
    network(() => new Response('', { status: 400 }));
    const pending = runToolContract(getStatus, entityInput);
    await vi.advanceTimersByTimeAsync(9000);
    failure(await pending, JsonRpcErrorCode.InvalidParams, 'upstream_bad_request');
  });
  it('echoes the publication allowance and carries pending buckets on both surfaces', async () => {
    const asOf = now / 1000;
    const bgp = {
      entityType: 'country',
      entityCode: 'US',
      datasource: 'bgp',
      from: asOf - 1200,
      until: asOf,
      step: 300,
      nativeStep: 300,
      values: [5, 5, null, null],
    };
    network((url) =>
      envelope(
        url.pathname.startsWith('/v2/signals/raw/')
          ? [url.searchParams.get('datasource') === 'bgp' ? [bgp] : []]
          : [],
      ),
    );
    const pending = runToolContract(getStatus, entityInput);
    await vi.advanceTimersByTimeAsync(9000);
    // parity() proves content[] carries the same values as structuredContent.
    const data = parity(await pending);
    expect((data.applied as { signals: object }).signals).toStrictEqual({
      sources: ['bgp', 'ping-slash24', 'merit-nt'],
      maxPoints: 2000,
      publicationAllowanceSeconds: 1800,
    });
    // The two trailing nulls end 300 s and 0 s before asOf, inside the 1800 s allowance.
    expect(data.signals).toEqual([
      {
        source: 'bgp',
        unit: 'Visible /24s',
        coverage: 'recent',
        series: [
          {
            entityType: 'country',
            entityCode: 'US',
            datasource: 'bgp',
            from: asOf - 1200,
            until: asOf,
            step: 300,
            nativeStep: 300,
            coverage: 'recent',
            nonNullCount: 2,
            nullCount: 0,
            pendingCount: 2,
            latest: { value: 5, bucketFrom: asOf - 900, bucketUntil: asOf - 600 },
            minimum: 5,
            maximum: 5,
          },
        ],
      },
      { source: 'ping-slash24', unit: 'Up /24s', coverage: 'no_data', series: [] },
      { source: 'merit-nt', unit: 'Unique Source IPs', coverage: 'no_data', series: [] },
    ]);
  });
});

describe('numeric source units', () => {
  it.each(Object.entries(units))(
    'names the IODA unit for %s signals on both surfaces from a static table',
    async (source, unit) => {
      const series = {
        entityType: 'country',
        entityCode: 'US',
        datasource: source,
        from: window.from,
        until: window.until,
        step: 1800,
        nativeStep: 600,
        values: [810631.3333333334, null],
      };
      network(() => envelope([[series]]));
      const result = await runToolContract(getSignals, { ...window, ...entityInput, source });
      const data = parity(result);
      expect(data.semantics).toStrictEqual({
        source,
        measurement: expect.any(String),
        unit,
        caveat: expect.any(String),
      });
      expect(data.series).toEqual([series]);
      expect(text(result)).toContain(`"unit": "${unit}"`);
      expect(calls.map((url) => url.pathname)).toEqual(['/v2/signals/raw/country/US']);
    },
  );
  it('names each status source unit on every signals entry, failed components included', async () => {
    /** Captured /outages/alerts?datasource=gtr row for country/FI; IODA scales gtr values by 10⁻⁶. */
    const gtr = {
      entity: {
        code: 'FI',
        name: 'Finland',
        type: 'country',
        subnames: [],
        attrs: { fqid: 'geo.netacuity.EU.FI' },
      },
      datasource: 'gtr',
      time: 1792414800,
      level: 'critical',
      condition: '< 0.8',
      method: 'sarima',
      value: 3266,
      historyValue: 4245,
    };
    network((url) =>
      url.searchParams.get('datasource') === 'merit-nt'
        ? new Response('', { status: 422 })
        : envelope(
            url.pathname.includes('/signals/')
              ? [[]]
              : url.pathname.endsWith('/alerts')
                ? [gtr]
                : [],
          ),
    );
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 1 });
    await vi.advanceTimersByTimeAsync(9000);
    const result = await pending;
    const data = parity(result);
    expect(data.signals).toEqual([
      { source: 'bgp', unit: 'Visible /24s', coverage: 'no_data', series: [] },
      { source: 'ping-slash24', unit: 'Up /24s', coverage: 'no_data', series: [] },
      { source: 'merit-nt', unit: 'Unique Source IPs', coverage: 'unknown', series: [] },
    ]);
    expect((data.components as { state: string }[]).map((component) => component.state)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'failed',
    ]);
    expect((data.alerts as { items: unknown[] }).items).toEqual([gtr]);
    const lines = text(result).split('\n');
    for (const unit of Object.values(units)) expect(lines).toContain(`      "unit": "${unit}",`);
    expect(calls.map((url) => url.pathname)).toEqual([
      '/v2/outages/events',
      '/v2/outages/alerts',
      ...Array(3).fill('/v2/signals/raw/country/US'),
    ]);
  });
  it('describes alert values per source instead of attaching a unit to alert records', () => {
    expect(AlertSchema.shape).not.toHaveProperty('unit');
    expect(AlertSchema.shape.value.description).toBe(
      'Source measurement at the transition. bgp (Visible /24s), ping-slash24 (Up /24s), and merit-nt (Unique Source IPs) report it in the source unit; gtr (method sarima) reports IODA Traffic divided by 1,000,000 and truncated to an integer.',
    );
    expect(AlertSchema.shape.historyValue.description).toBe(
      'Source baseline that value is compared with, on the same per-source scale as value: the source unit for bgp, ping-slash24, and merit-nt; Traffic divided by 1,000,000 and truncated for gtr.',
    );
  });
});

describe('unknown entity codes', () => {
  /** IODA's HTTP 400 for an unknown country or region code on /signals/raw, trimmed from a live reply. */
  const missingEntity = () =>
    Response.json(
      { error: 'cannot find corresponding metadata entity 0', data: null, copyright: hostile },
      { status: 400 },
    );
  const unknown = (url: URL) =>
    url.pathname.startsWith('/v2/signals/raw/') ? missingEntity() : envelope([]);
  const verify =
    'IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.';
  it.each([
    [
      'ioda_get_signals',
      () =>
        runToolContract(getSignals, {
          ...window,
          entityType: 'country',
          entityCode: 'zz',
          source: 'bgp',
        }),
    ],
    [
      'ioda_get_status',
      () => runToolContract(getStatus, { entityType: 'region', entityCode: '9999999' }),
    ],
  ] as const)(
    '%s reports entity_not_found with its search-first recovery on both surfaces',
    async (name, run) => {
      network(unknown);
      const pending = run();
      await vi.advanceTimersByTimeAsync(9000);
      const result = await pending;
      const error = failure(result, JsonRpcErrorCode.NotFound, 'entity_not_found');
      expect(error.message).toBe('IODA has no metadata entity for this entityType and entityCode.');
      expect(error.data?.recovery?.hint).toBe(
        `Call ioda_search_entities with entityType and the name as query, then retry ${name} with the selected entityType and a returned code as entityCode.`,
      );
      expect(text(result)).toContain(`Error: ${error.message}`);
      expect(text(result)).not.toContain('cannot find');
      expect(calls).toHaveLength(name === 'ioda_get_status' ? 5 : 1);
    },
  );
  it('keeps a signal-only not-found beside a returned event as partial status evidence', async () => {
    network((url) => (url.pathname === '/v2/outages/events' ? envelope([event]) : unknown(url)));
    const pending = runToolContract(getStatus, { entityType: 'country', entityCode: 'ZZ' });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    expect(data.detection).toBe('observed');
    const failed = (data.components as { component: string; failure?: unknown }[]).filter(
      (component) => component.failure,
    );
    expect(failed).toEqual(
      (['bgp', 'ping-slash24', 'merit-nt'] as const).map((source) => ({
        component: source,
        state: 'failed',
        failure: {
          code: JsonRpcErrorCode.NotFound,
          reason: 'entity_not_found',
          message: 'IODA has no metadata entity for this entityType and entityCode.',
          recovery: `Call ioda_search_entities with entityType and the name as query, then retry ioda_get_signals with the selected entityType and a returned code as entityCode. Use source ${source}.`,
        },
      })),
    );
  });
  it.each([
    [
      'ioda_find_outages',
      () => runToolContract(findOutages, { ...window, entityType: 'country', entityCode: 'zz' }),
      'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.',
    ],
    [
      'ioda_get_alerts',
      () => runToolContract(getAlerts, { ...window, entityType: 'country', entityCode: 'zz' }),
      'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.',
    ],
  ] as const)(
    '%s adds the verify-code clause to an empty first page for an entityCode, with no extra request',
    async (_, run, zeroHit) => {
      network(unknown);
      const data = parity(await run());
      expect(data.notice).toBe(`${zeroHit} ${verify}`);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.searchParams.get('entityCode')).toBe('ZZ');
    },
  );
  const eventsZeroHit =
    'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.';
  const alertsZeroHit =
    'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.';
  it.each([
    [
      'global',
      { ...window },
      `extendWindowSeconds defaulted to 86400 (one day) for global scope, so events that began more than a day before from can be missing. Add entityType for the 14-day default, or pass extendWindowSeconds explicitly; large global extensions can time out. ${eventsZeroHit}`,
      alertsZeroHit,
    ],
    ['type only', { ...window, entityType: 'country' }, eventsZeroHit, alertsZeroHit],
    [
      'later page',
      { ...window, entityType: 'country', entityCode: 'ZZ', page: 1 },
      'This page is empty. Call ioda_find_outages with page 0 and unchanged filters, or return to the previous page.',
      'This page is empty. Call ioda_get_alerts with page 0 and unchanged filters, or return to the previous page.',
    ],
    [
      'related scope',
      { ...window, entityType: 'region', relatedToType: 'country', relatedToCode: 'ZZ' },
      `${eventsZeroHit} ${verifyScope}`,
      `${alertsZeroHit} ${verifyScope}`,
    ],
  ])(
    'omits the verify-code clause for a %s empty page',
    async (_, input, eventsNotice, alertsNotice) => {
      for (const [run, notice] of [
        [() => runToolContract(findOutages, input), eventsNotice],
        [() => runToolContract(getAlerts, input), alertsNotice],
      ] as const) {
        network(unknown);
        expect(rowGuidance(parity(await run()).notice)).toBe(notice);
      }
      expect(calls).toHaveLength(2);
    },
  );
  /** A shape-valid scope IODA has no entity for: UK is not an ISO country code (GB is). */
  const unknownScope = { entityType: 'region', relatedToType: 'country', relatedToCode: 'uk' };
  it.each([
    [
      'ioda_search_entities',
      () => runToolContract(searchEntities, unknownScope),
      'IODA lists no region entities within country UK.',
    ],
    [
      'ioda_find_outages',
      () => runToolContract(findOutages, { ...window, ...unknownScope }),
      'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.',
    ],
    [
      'ioda_get_alerts',
      () => runToolContract(getAlerts, { ...window, ...unknownScope }),
      'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.',
    ],
    [
      'ioda_summarize_outages',
      () => runToolContract(summarizeOutages, { ...window, ...unknownScope }),
      'No outage summaries were returned for this scope and window. Call ioda_find_outages for detected events or ioda_get_signals for measurement coverage, or ioda_summarize_outages with a wider window or fewer filters. This is not an all-clear.',
    ],
  ] as const)(
    '%s adds the verify-scope clause to an empty first scoped page, with no extra request',
    async (_, run, zeroHit) => {
      network(unknown);
      const data = parity(await run());
      expect(rowGuidance(data.notice)).toBe(`${zeroHit} ${verifyScope}`);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.searchParams.get('relatedTo')).toBe('country/UK');
    },
  );
  const pastEnd =
    'This page is empty. Call ioda_search_entities with page 0 and unchanged filters, or return to the previous page.';
  const shorterQuery =
    'No matching entities. Call ioda_search_entities with a shorter query or omit query to list this entity type.';
  it.each([
    [
      'an unknown entityCode',
      { entityType: 'country', entityCode: ' zz ' },
      'IODA lists no country with entityCode ZZ. Call ioda_search_entities with entityType country and the name as query to find its code.',
    ],
    [
      'an unknown geoasn entityCode',
      { entityType: 'geoasn', entityCode: 'as40934-0576' },
      'IODA lists no geoasn with entityCode 40934-576. Call ioda_search_entities with entityType geoasn and the name as query to find its code.',
    ],
    [
      'a known entityCode past its only page',
      { entityType: 'country', entityCode: 'IR', page: 1 },
      pastEnd,
    ],
    ['a query', { entityType: 'region', query: ' atlantis ' }, shorterQuery],
    ['a query past the end', { entityType: 'region', query: 'atlantis', page: 2 }, pastEnd],
    ['a query within a scope', { ...unknownScope, query: 'x' }, `${shorterQuery} ${verifyScope}`],
    ['a type listing', { entityType: 'geoasn' }, 'IODA lists no geoasn entities.'],
    [
      'a scoped listing',
      unknownScope,
      `IODA lists no region entities within country UK. ${verifyScope}`,
    ],
  ])('words an empty resolver page for %s by the inputs given', async (_, input, notice) => {
    network(() => envelope([]));
    const data = parity(await runToolContract(searchEntities, input));
    expect(data.entities).toEqual([]);
    expect(data.notice).toBe(notice);
    expect(calls).toHaveLength(1);
  });
  it('omits the verify-scope clause on a later empty scoped page', async () => {
    for (const [tool, run] of [
      ['ioda_search_entities', () => runToolContract(searchEntities, { ...unknownScope, page: 1 })],
      [
        'ioda_find_outages',
        () => runToolContract(findOutages, { ...window, ...unknownScope, page: 1 }),
      ],
      [
        'ioda_summarize_outages',
        () => runToolContract(summarizeOutages, { ...window, ...unknownScope, page: 1 }),
      ],
    ] as const) {
      network(unknown);
      expect(rowGuidance(parity(await run()).notice)).toBe(
        `This page is empty. Call ${tool} with page 0 and unchanged filters, or return to the previous page.`,
      );
    }
    expect(calls).toHaveLength(3);
  });
});

/** The thrown error of a normalization that must reject. */
function rejection(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as { message: string; data?: { reason?: string } };
  }
  return expect.unreachable('expected a rejection');
}
const origin = 'https://api.ioda.inetintel.cc.gatech.edu';

describe('geoasn entity vocabulary', () => {
  const grammar =
    'geoasn codes are an ASN, a hyphen, and a numeric region code or two-letter country code, such as 40934-576 or 59962-IR; resolve names with ioda_search_entities.';
  const range = 'ASN must be 1–4294967295; region codes must be positive.';
  /** Captured /entities/query rows: geoasn rows carry object subnames, other types arrays. */
  const fortinet = {
    code: '40934-576',
    name: 'FORTINET -- British Columbia',
    type: 'geoasn',
    subnames: { asn: 'AS40934', region: 'British Columbia' },
    attrs: { fqid: 'geoasn.40934-576', org: 'Fortinet Inc.' },
  };
  const tehranRegion = {
    code: '1829',
    name: 'Tehran',
    type: 'region',
    subnames: [],
    attrs: { fqid: 'geo.netacuity.AS.IR.1829', country_code: 'IR' },
  };
  /** Captured geoasn event and alert entities carry array subnames. */
  const rialcom = {
    code: '34456-3437',
    name: 'RIALCOM-AS -- Moskovsskaya',
    subnames: [],
    type: 'geoasn',
    attrs: { fqid: 'geoasn.34456-3437', org: 'Rial Com JSC' },
  };
  const geoasnEvent = {
    entity: rialcom,
    from: 1792102800,
    until: 1792105200,
    score: 3937.5,
    datasource: 'ping-slash24',
    method: 'median',
  };
  const geoasnAlert = {
    datasource: 'ping-slash24',
    entity: rialcom,
    time: 1792102800,
    level: 'critical',
    condition: '< 0.8',
    value: 1,
    historyValue: 64,
    method: 'median',
  };
  /** Captured /signals/raw/geoasn/40934-576 bgp series. */
  const fortinetSeries = {
    entityType: 'geoasn',
    entityCode: '40934-576',
    entityName: 'FORTINET -- British Columbia',
    entityFqid: 'geoasn.40934-576',
    datasource: 'bgp',
    subtype: '',
    from: 1792551600,
    until: 1792555200,
    step: 300,
    nativeStep: 300,
    values: Array(12).fill(54),
  };

  it.each([
    ['country', ' us ', 'US'],
    ['region', ' 0576 ', '576'],
    ['asn', ' as000123 ', '123'],
    ['ASN', 'AS4294967295', '4294967295'],
  ])('keeps %s code %j canonical as %s', (type, code, canonical) => {
    expect(entityFilter({ entityType: type, entityCode: code })).toEqual({
      entityType: type.toLowerCase(),
      entityCode: canonical,
    });
  });
  it.each([
    [
      { entityType: 'country', entityCode: 'USA' },
      'Country codes require exactly two ASCII letters; resolve names with ioda_search_entities.',
    ],
    [
      { entityType: 'region', entityCode: 'AS12' },
      'Region and ASN codes require positive decimal digits.',
    ],
    [
      { entityType: 'asn', entityCode: '40934-576' },
      'Region and ASN codes require positive decimal digits.',
    ],
    [{ entityType: 'region', entityCode: '000' }, range],
    [{ entityType: 'asn', entityCode: '4294967296' }, range],
    [{ entityCode: 'US' }, 'entityCode requires entityType.'],
  ])('keeps rejecting %j with its message', (input, message) => {
    const error = rejection(() => entityFilter(input));
    expect(error.message).toBe(message);
    expect(error.data?.reason).toBe('invalid_entity');
  });
  it('lists geoasn in the entityType vocabulary', () => {
    expect(entityFilter({ entityType: ' GeoASN ' })).toEqual({ entityType: 'geoasn' });
    const error = rejection(() => entityFilter({ entityType: 'continent' }));
    expect(error.message).toBe('entityType must be country, region, asn, or geoasn.');
    expect(error.data?.reason).toBe('invalid_entity');
  });
  it.each([
    [' as040934-0576 ', '40934-576'],
    ['59962-ir', '59962-IR'],
    ['AS34456-Ru', '34456-RU'],
    ['14813-504', '14813-504'],
    ['4294967295-1', '4294967295-1'],
  ])('normalizes geoasn %j to %s', (code, canonical) => {
    expect(entityFilter({ entityType: 'geoasn', entityCode: code })).toEqual({
      entityType: 'geoasn',
      entityCode: canonical,
    });
  });
  it.each([
    ['40934', grammar],
    ['40934-', grammar],
    ['-576', grammar],
    ['40934-576-1', grammar],
    ['40934-USA', grammar],
    ['40934-I', grammar],
    ['AS-576', grammar],
    ['ASN40934-576', grammar],
    ['40934 -576', grammar],
    ['40934–576', grammar],
    ['0-IR', range],
    ['000-576', range],
    ['40934-0', range],
    ['4294967296-576', range],
    ['99999999999-576', range],
  ])('rejects geoasn %j before any request', (code, message) => {
    const error = rejection(() => entityFilter({ entityType: 'geoasn', entityCode: code }));
    expect(error.message).toBe(message);
    expect(error.data?.reason).toBe('invalid_entity');
  });
  it.each([
    ['/v2/signals/raw/geoasn/40934-576', true],
    ['/v2/signals/raw/asn/40934', true],
    ['/v2/signals/raw/continent/EU', false],
    ['/v2/signals/raw/geoasn/40934-576/extra', false],
    ['/v2/outages/summary', true],
    ['/v2/outages/summary/extra', false],
  ])('provenance endpoint %s validates: %s', (path, valid) => {
    const provenance = { endpoint: `${origin}${path}`, fetchedAt: '2026-10-21T05:40:40Z' };
    expect(ProvenanceSchema.safeParse(provenance).success).toBe(valid);
  });
  it('resolves a canonical geoasn code with object subnames beside array subnames on both surfaces', async () => {
    network(() => envelope([fortinet, tehranRegion]));
    const data = parity(
      await runToolContract(searchEntities, {
        entityType: ' GEOASN ',
        entityCode: ' as040934-0576 ',
      }),
    );
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({
      entityType: 'geoasn',
      entityCode: '40934-576',
      limit: '20',
      page: '0',
    });
    expect(data.entities).toEqual([fortinet, tehranRegion]);
    expect(data.applied).toEqual({
      entityType: 'geoasn',
      entityCode: '40934-576',
      limit: 20,
      page: 0,
    });
  });
  it('fetches geoasn signals with a provenance endpoint on the geoasn path', async () => {
    network(() => envelope([[fortinetSeries]]));
    const data = parity(
      await runToolContract(getSignals, {
        ...window,
        entityType: 'geoasn',
        entityCode: 'AS040934-0576',
        source: 'bgp',
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/v2/signals/raw/geoasn/40934-576');
    expect(data.series).toEqual([fortinetSeries]);
    expect(data.provenance).toMatchObject({
      endpoint: `${origin}/v2/signals/raw/geoasn/40934-576`,
    });
    expect(data.applied).toEqual({
      ...window,
      entityType: 'geoasn',
      entityCode: '40934-576',
      source: 'bgp',
      maxPoints: 200,
    });
  });
  it('collects geoasn status evidence with every component validated', async () => {
    network((url) =>
      envelope(
        url.pathname.startsWith('/v2/signals/')
          ? [url.searchParams.get('datasource') === 'bgp' ? [fortinetSeries] : []]
          : [],
      ),
    );
    const pending = runToolContract(getStatus, { entityType: 'GEOASN', entityCode: ' 40934-576 ' });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    expect(calls).toHaveLength(5);
    expect(calls.map((url) => url.pathname)).toEqual([
      '/v2/outages/events',
      '/v2/outages/alerts',
      ...Array(3).fill('/v2/signals/raw/geoasn/40934-576'),
    ]);
    for (const url of calls.slice(0, 2)) {
      expect(url.searchParams.get('entityType')).toBe('geoasn');
      expect(url.searchParams.get('entityCode')).toBe('40934-576');
    }
    expect(data.entity).toEqual({ entityType: 'geoasn', entityCode: '40934-576' });
    const components = data.components as { state: string; provenance?: { endpoint: string } }[];
    expect(components.map((component) => component.state)).toEqual(Array(5).fill('ok'));
    expect(components.slice(2).map((component) => component.provenance?.endpoint)).toEqual(
      Array(3).fill(`${origin}/v2/signals/raw/geoasn/40934-576`),
    );
  });
  it('filters events and alerts by canonical geoasn codes whose records carry array subnames', async () => {
    network(() => envelope([geoasnEvent]));
    let data = parity(
      await runToolContract(findOutages, {
        ...window,
        entityType: 'geoasn',
        entityCode: 'as34456-03437',
      }),
    );
    expect(calls[0]?.searchParams.get('entityType')).toBe('geoasn');
    expect(calls[0]?.searchParams.get('entityCode')).toBe('34456-3437');
    expect(data.events).toEqual([geoasnEvent]);
    expect(data.applied).toMatchObject({
      entityType: 'geoasn',
      entityCode: '34456-3437',
      scope: 'entity',
    });

    calls.length = 0;
    network(() => envelope([geoasnAlert]));
    data = parity(
      await runToolContract(getAlerts, {
        ...window,
        entityType: 'geoasn',
        entityCode: ' 34456-ru ',
      }),
    );
    expect(calls[0]?.searchParams.get('entityCode')).toBe('34456-RU');
    expect(data.alerts).toEqual([geoasnAlert]);
    expect(data.applied).toMatchObject({ entityType: 'geoasn', entityCode: '34456-RU' });
  });
  it('rejects a malformed geoasn code on every tool before HTTP with a geoasn-aware recovery', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const code = { entityType: 'geoasn', entityCode: '40934-USA' };
    const results = [
      ['ioda_search_entities', await runToolContract(searchEntities, code)],
      ['ioda_get_status', await runToolContract(getStatus, code)],
      ['ioda_find_outages', await runToolContract(findOutages, { ...window, ...code })],
      [
        'ioda_get_signals',
        await runToolContract(getSignals, { ...window, ...code, source: 'bgp' }),
      ],
      ['ioda_get_alerts', await runToolContract(getAlerts, { ...window, ...code })],
    ] as const;
    for (const [name, result] of results) {
      lexicalFailure(result, name, 'entityCode', lexicalCodeMessage);
    }
    expect(calls).toHaveLength(0);
  });
  /** Smallest thread CPU time of three geoasn normalizations, after a warm-up. */
  const normalizeCpu = (code: string) => {
    const run = () => {
      try {
        return entityFilter({ entityType: 'geoasn', entityCode: code });
      } catch (error) {
        return error;
      }
    };
    run();
    let ms = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = process.threadCpuUsage();
      run();
      const used = process.threadCpuUsage(start);
      ms = Math.min(ms, (used.user + used.system) / 1000);
    }
    return ms;
  };
  it.each([
    ['a long digit run with no hyphen', 5120, (n: number) => '1'.repeat(n)],
    [
      'an AS prefix and zero run ending in a bare hyphen',
      1250,
      (n: number) => `AS${'0'.repeat(n)}-`,
    ],
    ['repeated hyphenated pairs', 1250, (n: number) => '1-'.repeat(n / 2)],
    ['one long line ending in a break', 1250, (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', 1250, (n: number) => '  \r\n'.repeat(n / 4)],
    ['breaks between an ASN and a region', 1250, (n: number) => `1${'  \r\n'.repeat(n / 4)}-2`],
  ])(
    'geoasn normalization timing stays linear for %s across a 64× span',
    (_, start, shape) => {
      const samples: number[] = [];
      for (let n = start; n <= start * 64; n *= 2) {
        const ms = normalizeCpu(shape(n));
        expect(ms).toBeLessThan(250);
        samples.push(ms);
      }
      expect(samples).toHaveLength(7);
      expect((samples.at(-1) ?? 0) / Math.max(samples[0] ?? 0, 0.05)).toBeLessThan(256);
    },
    60_000,
  );
});

describe('relatedTo scope', () => {
  const half =
    'relatedToType and relatedToCode go together; provide both, or omit both for no scope.';
  const needsType =
    'A relatedTo scope requires entityType, the type of entity to list within it; without it IODA matches codes across entity types.';
  const noCode =
    'A relatedTo scope lists every entityType entity within it, so it cannot be combined with entityCode; omit entityCode to use the scope.';
  const pageOnly =
    'A relatedTo scope is served at page 0 only; IODA cannot continue scoped alerts.';
  const scopedRoute =
    'Call ioda_get_alerts with page 0 and a narrower window, or list the scope entities with ioda_search_entities (same entityType and scope) and call ioda_get_alerts per entityCode.';
  const fullScopedPage = `This scoped page is full and IODA cannot continue scoped alerts past page 0, so more transitions may exist. ${scopedRoute}`;
  const regionScope = { entityType: 'region', relatedToType: ' Country ', relatedToCode: 'ir' };
  /** Captured /entities/query?entityType=region&relatedTo=country/IR rows. */
  const iranRegions = [
    {
      code: '1821',
      name: '[Invalid Region (1821)]',
      type: 'region',
      subnames: [],
      attrs: {
        fqid: 'geo.netacuity.AS.IR.1821',
        country_code: 'IR',
        country_name: 'Iran (Islamic Republic Of)',
      },
    },
    {
      code: '1823',
      name: 'Bushehr',
      type: 'region',
      subnames: [],
      attrs: {
        fqid: 'geo.netacuity.AS.IR.1823',
        country_code: 'IR',
        country_name: 'Iran (Islamic Republic Of)',
        ne_region_id: '3210',
      },
    },
  ];
  /** Captured /entities/query?entityType=asn&search=Iran&relatedTo=country/IR rows. */
  const iranNetworks = [
    {
      code: '25306',
      name: 'AS25306 (INSTITUTE-ISIRAN)',
      type: 'asn',
      subnames: [],
      attrs: { org: 'IsIran', fqid: 'asn.25306', ip_count: '8448', name: 'INSTITUTE-ISIRAN' },
    },
  ];
  /** Captured /outages/events?entityType=region&relatedTo=country/RU rows, pages 0 and 1. */
  const russianRegion = (
    code: string,
    name: string,
    from: number,
    until: number,
    score: number,
  ) => ({
    entity: {
      code,
      name,
      type: 'region',
      subnames: [],
      attrs: {
        fqid: `geo.netacuity.EU.RU.${code}`,
        country_code: 'RU',
        country_name: 'Russian Federation',
      },
    },
    from,
    until,
    score,
    datasource: 'bgp',
    method: 'median',
  });
  const russianEvents = [
    russianRegion('3448', 'Tambov', 1791106500, 1792316100, 53760.00000000001),
    russianRegion('3442', 'Volgograd', 1791839400, 1792558800, 20444.994499449946),
    russianRegion('3422', 'Leningrad', 1792283700, 1792286700, 96.4974982130093),
  ];
  /** Captured /outages/alerts?entityType=region&relatedTo=country/IR rows. */
  const iranAlert = (code: string, name: string, value: number, historyValue: number) => ({
    datasource: 'ping-slash24',
    entity: {
      code,
      name,
      type: 'region',
      subnames: [],
      attrs: {
        fqid: `geo.netacuity.AS.IR.${code}`,
        country_code: 'IR',
        country_name: 'Iran (Islamic Republic Of)',
      },
    },
    time: 1792102800,
    level: 'critical',
    condition: '< 0.8',
    value,
    historyValue,
    method: 'median',
  });
  const iranAlerts = [iranAlert('1825', 'Fars', 350, 6327), iranAlert('1829', 'Tehran', 115, 1985)];
  const query = (url: URL | undefined) => Object.fromEntries(url?.searchParams ?? []);

  it.each([
    [{}, undefined],
    [{ entityType: 'region', relatedToType: ' ', relatedToCode: '' }, undefined],
    [regionScope, { relatedToType: 'country', relatedToCode: 'IR' }],
    [
      { entityType: 'country', relatedToType: 'ASN', relatedToCode: ' as042337 ' },
      { relatedToType: 'asn', relatedToCode: '42337' },
    ],
    [
      { entityType: 'asn', relatedToType: 'region', relatedToCode: '01829' },
      { relatedToType: 'region', relatedToCode: '1829' },
    ],
    [
      { entityType: 'asn', relatedToType: 'geoasn', relatedToCode: 'AS060627-ir' },
      { relatedToType: 'geoasn', relatedToCode: '60627-IR' },
    ],
    [
      { entityType: 'geoasn', entityCode: ' ', relatedToType: 'country', relatedToCode: 'IR' },
      { relatedToType: 'country', relatedToCode: 'IR' },
    ],
  ])('normalizes scope %j to %j', (input, scope) => {
    expect(relatedScope(input)).toEqual(scope);
  });
  it.each([
    [{ entityType: 'region', relatedToType: 'country' }, half],
    [{ entityType: 'region', relatedToCode: 'IR' }, half],
    [{ entityType: 'region', relatedToType: 'country', relatedToCode: '  ' }, half],
    [
      { entityType: 'region', relatedToType: 'continent', relatedToCode: 'EU' },
      'relatedToType must be country, region, asn, or geoasn.',
    ],
    [
      { entityType: 'region', relatedToType: 'country', relatedToCode: 'IRN' },
      'relatedToCode does not fit relatedToType country: Country codes require exactly two ASCII letters; resolve names with ioda_search_entities.',
    ],
    [
      { entityType: 'asn', relatedToType: 'region', relatedToCode: '0' },
      'relatedToCode does not fit relatedToType region: ASN must be 1–4294967295; region codes must be positive.',
    ],
    [
      { entityType: 'asn', relatedToType: 'geoasn', relatedToCode: '60627' },
      'relatedToCode does not fit relatedToType geoasn: geoasn codes are an ASN, a hyphen, and a numeric region code or two-letter country code, such as 40934-576 or 59962-IR; resolve names with ioda_search_entities.',
    ],
    [{ relatedToType: 'country', relatedToCode: 'IR' }, needsType],
    [{ entityType: '  ', relatedToType: 'country', relatedToCode: 'IR' }, needsType],
    [
      { entityType: 'region', entityCode: '1829', relatedToType: 'country', relatedToCode: 'IR' },
      noCode,
    ],
  ])('rejects scope %j with invalid_scope', (input, message) => {
    const error = rejection(() => relatedScope(input));
    expect(error.message).toBe(message);
    expect(error.data?.reason).toBe('invalid_scope');
  });
  it('lists the regions of a country and combines a scope with query', async () => {
    network(() => envelope(iranRegions));
    let data = parity(await runToolContract(searchEntities, regionScope));
    expect(calls).toHaveLength(1);
    expect(query(calls[0])).toEqual({
      entityType: 'region',
      relatedTo: 'country/IR',
      limit: '20',
      page: '0',
    });
    expect(data.entities).toEqual(iranRegions);
    expect(data.applied).toEqual({
      entityType: 'region',
      relatedToType: 'country',
      relatedToCode: 'IR',
      limit: 20,
      page: 0,
      scope: 'related',
    });

    calls.length = 0;
    network(() => envelope(iranNetworks));
    data = parity(
      await runToolContract(searchEntities, {
        entityType: 'asn',
        query: ' Iran ',
        relatedToType: 'country',
        relatedToCode: 'IR',
      }),
    );
    expect(query(calls[0])).toEqual({
      entityType: 'asn',
      search: 'Iran',
      relatedTo: 'country/IR',
      limit: '20',
      page: '0',
    });
    expect(data.entities).toEqual(iranNetworks);
    expect(data.applied).toMatchObject({ query: 'Iran', scope: 'related' });
  });
  it('continues scoped events with nextPage', async () => {
    const pages = (url: URL) =>
      envelope(
        url.searchParams.get('page') === '0' ? russianEvents.slice(0, 2) : russianEvents.slice(2),
      );
    network(pages);
    const scope = { relatedToType: 'country', relatedToCode: 'ru' };
    let data = parity(
      await runToolContract(findOutages, { ...window, entityType: 'region', ...scope, limit: 2 }),
    );
    expect(query(calls[0])).toMatchObject({
      entityType: 'region',
      relatedTo: 'country/RU',
      page: '0',
    });
    expect(calls[0]?.searchParams.has('entityCode')).toBe(false);
    expect(data.events).toEqual(russianEvents.slice(0, 2));
    expect(data.pagination).toEqual({
      page: 0,
      limit: 2,
      returned: 2,
      more: 'possible',
      nextPage: 1,
    });
    expect(data.applied).toMatchObject({
      entityType: 'region',
      relatedToType: 'country',
      relatedToCode: 'RU',
      scope: 'related',
    });
    expect(rowGuidance(data.notice)).toBe(
      'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.',
    );

    network(pages);
    data = parity(
      await runToolContract(findOutages, {
        ...window,
        entityType: 'region',
        ...scope,
        limit: 2,
        page: 1,
      }),
    );
    expect(query(calls[1])).toMatchObject({ relatedTo: 'country/RU', page: '1', limit: '2' });
    expect(data.events).toEqual(russianEvents.slice(2));
    expect(data.pagination).toEqual({ page: 1, limit: 2, returned: 1, more: 'no' });
    expect(rowGuidance(data.notice)).toBeUndefined();
  });
  it('serves scoped alerts at page 0 and reports a full scoped page without nextPage', async () => {
    network(() => envelope(iranAlerts));
    let data = parity(await runToolContract(getAlerts, { ...window, ...regionScope, limit: 2 }));
    expect(query(calls[0])).toMatchObject({
      entityType: 'region',
      relatedTo: 'country/IR',
      limit: '2',
      page: '0',
    });
    expect(data.alerts).toEqual(iranAlerts);
    expect(data.pagination).toEqual({ page: 0, limit: 2, returned: 2, more: 'possible' });
    expect(data.truncated).toEqual({ shown: 2, cap: 2 });
    expect(rowGuidance(data.notice)).toBe(fullScopedPage);
    expect(data.applied).toEqual({
      entityType: 'region',
      relatedToType: 'country',
      relatedToCode: 'IR',
      ...window,
      extendWindowSeconds: 0,
      limit: 2,
      page: 0,
      scope: 'related',
      source: 'all',
    });

    calls.length = 0;
    network(() => envelope(iranAlerts));
    data = parity(await runToolContract(getAlerts, { ...window, ...regionScope }));
    expect(data.pagination).toEqual({ page: 0, limit: 20, returned: 2, more: 'no' });
    expect(rowGuidance(data.notice)).toBeUndefined();
    expect(data.truncated).toBeUndefined();
  });
  it('rejects a scoped alert page above 0 before HTTP with the page-0 route', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(getAlerts, { ...window, ...regionScope, page: 1 });
    const error = failure(result, JsonRpcErrorCode.ValidationError, 'invalid_scope');
    expect(error.message).toBe(pageOnly);
    expect(error.data?.recovery?.hint).toBe(scopedRoute);
    expect(text(result)).toContain(`Error: ${pageOnly}`);
    expect(calls).toHaveLength(0);
  });
  it('rejects scope violations on every scoped tool before HTTP with its recovery', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const noType = { relatedToType: 'country', relatedToCode: 'IR' };
    const withCode = { ...regionScope, entityCode: '1829' };
    const results = [
      ['ioda_search_entities', noCode, await runToolContract(searchEntities, withCode)],
      [
        'ioda_search_entities',
        noCode,
        await runToolContract(searchEntities, { ...withCode, query: 'Tehran' }),
      ],
      [
        'ioda_find_outages',
        needsType,
        await runToolContract(findOutages, { ...window, ...noType }),
      ],
      ['ioda_find_outages', noCode, await runToolContract(findOutages, { ...window, ...withCode })],
      [
        'ioda_find_outages',
        half,
        await runToolContract(findOutages, {
          ...window,
          entityType: 'region',
          relatedToCode: 'IR',
        }),
      ],
      ['ioda_get_alerts', needsType, await runToolContract(getAlerts, { ...window, ...noType })],
      ['ioda_get_alerts', noCode, await runToolContract(getAlerts, { ...window, ...withCode })],
    ] as const;
    const recoveries = {
      ioda_search_entities:
        'Call ioda_search_entities with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields.',
      ioda_find_outages:
        'Call ioda_find_outages with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
      ioda_get_alerts:
        'Call ioda_get_alerts at page 0 with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
    };
    for (const [name, message, result] of results) {
      const error = failure(result, JsonRpcErrorCode.ValidationError, 'invalid_scope');
      expect(error.message).toBe(message);
      expect(error.data?.recovery?.hint).toBe(recoveries[name]);
      expect(text(result)).toContain(`Error: ${message}`);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('outage summary ranking', () => {
  const query = (url: URL | undefined) => Object.fromEntries(url?.searchParams ?? []);
  const seconds = { from: String(window.from), until: String(window.until) };
  const nextPage =
    'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.';
  const zeroHit =
    'No outage summaries were returned for this scope and window. Call ioda_find_outages for detected events or ioda_get_signals for measurement coverage, or ioda_summarize_outages with a wider window or fewer filters. This is not an all-clear.';
  const pastEnd =
    'This page is empty. Call ioda_summarize_outages with page 0 and unchanged filters, or return to the previous page.';
  const verify =
    'IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.';
  const order = 'scores.overall descending';
  const country = (
    code: string,
    name: string,
    fqid: string,
    scores: Record<string, number>,
    eventCount: number,
  ) => ({
    scores,
    event_cnt: eventCount,
    entity: { code, name, subnames: [], type: 'country', attrs: { fqid } },
  });
  /** Captured /outages/summary?entityType=country&limit=5 rows, in IODA's order. */
  const countryRanking = [
    country(
      'LT',
      'Lithuania',
      'geo.netacuity.EU.LT',
      {
        'gtr.sarima': 661437.4166077297,
        'ping-slash24.median': 4895.274584929757,
        overall: 3237917775.041415,
      },
      2,
    ),
    country(
      'AM',
      'Armenia',
      'geo.netacuity.AS.AM',
      {
        'bgp.median': 26505.0505050505,
        'ping-slash24.median': 4910.95890410959,
        overall: 130165213.78165214,
      },
      2,
    ),
    country(
      'PG',
      'Papua New Guinea',
      'geo.netacuity.OC.PG',
      {
        'bgp.median': 24082.018927444795,
        'ping-slash24.median': 3539.8230088495575,
        overall: 85246084.69891962,
      },
      2,
    ),
    country(
      'BB',
      'Barbados',
      'geo.netacuity.NA.BB',
      {
        'bgp.median': 15856.643356643357,
        'ping-slash24.median': 9682.947217578218,
        overall: 80779126.5338435,
      },
      3,
    ),
    country(
      'BI',
      'Burundi',
      'geo.netacuity.AF.BI',
      {
        'bgp.median': 15385.62091503268,
        'ping-slash24.median': 6169.4915254237285,
        overall: 27472124.736900404,
      },
      7,
    ),
  ];
  /** Captured /outages/summary?entityType=country&entityCode=IR row. */
  const iran = country(
    'IR',
    'Iran (Islamic Republic Of)',
    'geo.netacuity.AS.IR',
    { 'ping-slash24.median': 7408.074525231145, overall: 7408.074525231145 },
    2,
  );
  const iranRegion = (code: string, name: string, scores: Record<string, number>) => ({
    scores,
    event_cnt: 1,
    entity: {
      code,
      name,
      type: 'region',
      subnames: [],
      attrs: {
        fqid: `geo.netacuity.AS.IR.${code}`,
        country_code: 'IR',
        country_name: 'Iran (Islamic Republic Of)',
      },
    },
  });
  /** Captured /outages/summary?entityType=region&relatedTo=country/IR rows, trimmed. */
  const iranRegions = [
    iranRegion('1828', 'Semnan', { 'bgp.median': 21805.405405405407, overall: 21805.405405405407 }),
    iranRegion('1852', 'Alborz', {
      'ping-slash24.median': 11777.493913103117,
      overall: 11777.493913103117,
    }),
    iranRegion('1842', 'West Azarbaijan', {
      'ping-slash24.median': 10943.062631105782,
      overall: 10943.062631105782,
    }),
  ];
  const recoveries = {
    invalid_scope:
      'Call ioda_summarize_outages with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
  };

  it('advertises a required entityType, the shared scope and page inputs, and no source or orderBy', () => {
    expect(Object.keys(summarizeOutages.input.shape)).toEqual([
      'entityType',
      'entityCode',
      'relatedToType',
      'relatedToCode',
      'from',
      'until',
      'limit',
      'page',
      'ignoreMethods',
      'extendWindowSeconds',
    ]);
    expect(summarizeOutages.input.parse({ ...window, entityType: 'country' })).toEqual({
      ...window,
      entityType: 'country',
      limit: 20,
      page: 0,
      extendWindowSeconds: 1209600,
    });
    expect(summarizeOutages.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(summarizeOutages.description).toContain(
      "IODA merges overlapping events from different sources, scores each merged event as the product of its sources' scores, and sums the merged events into overall;",
    );
    expect(summarizeOutages.description).toContain(
      'Scores are window totals for ranking the rows of one request, not current status, and are not comparable across requests with different windows.',
    );
  });
  it('declares every reason it can raise, with the recovery the service sends for upstream ones', () => {
    const entries = summarizeOutages.errors ?? [];
    expect(entries.map((entry) => entry.reason)).toEqual([
      'invalid_entity',
      'invalid_scope',
      'invalid_window',
      'upstream_bad_request',
      'upstream_unprocessable',
      'entity_not_found',
      'upstream_rate_limited',
      'upstream_queue_full',
      'upstream_timeout',
      'upstream_schema',
      'response_too_large',
    ]);
    const upstream = entries.filter((entry) => entry.reason.startsWith('upstream_'));
    expect(upstream).toHaveLength(6);
    for (const entry of [
      ...upstream,
      ...entries.filter((entry) =>
        ['entity_not_found', 'response_too_large'].includes(entry.reason),
      ),
    ])
      expect(entry.recovery).toBe(
        recoveryFor(entry.reason as Parameters<typeof recoveryFor>[0], 'ioda_summarize_outages'),
      );
  });
  it("ranks one entity type with IODA's rows, order and request unchanged on both surfaces", async () => {
    network(() => envelope(countryRanking));
    const data = parity(
      await runToolContract(summarizeOutages, { ...window, entityType: ' Country ', limit: 5 }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/v2/outages/summary');
    expect(query(calls[0])).toEqual({
      ...seconds,
      entityType: 'country',
      extendWindow: '1209600',
      limit: '5',
      page: '0',
    });
    expect(calls[0]?.searchParams.has('datasource')).toBe(false);
    expect(calls[0]?.searchParams.has('orderBy')).toBe(false);
    expect(data.summaries).toEqual(countryRanking);
    expect(data.applied).toEqual({
      entityType: 'country',
      ...window,
      extendWindowSeconds: 1209600,
      limit: 5,
      page: 0,
      scope: 'entity',
      order,
    });
    expect(data.pagination).toEqual({
      page: 0,
      limit: 5,
      returned: 5,
      more: 'possible',
      nextPage: 1,
    });
    expect(data.truncated).toEqual({ shown: 5, cap: 5 });
    expect(data.notice).toBe(nextPage);
    expect((data.provenance as { endpoint: string }).endpoint).toBe(`${origin}/v2/outages/summary`);
  });
  it('relays a page out of score order unchanged, with no local sort or rescoring', async () => {
    const unsorted = [countryRanking[4], countryRanking[0], countryRanking[2]];
    network(() => envelope(unsorted));
    const data = parity(
      await runToolContract(summarizeOutages, { ...window, entityType: 'country' }),
    );
    expect(data.summaries).toEqual(unsorted);
    expect(data.pagination).toEqual({ page: 0, limit: 20, returned: 3, more: 'no' });
    expect(data.notice).toBeUndefined();
    expect(data.truncated).toBeUndefined();
  });
  it('keeps every numeric score key and extra row fields verbatim', async () => {
    const row = {
      scores: { 'merit-nt.median': 0, 'bgp.sarima': 12.5, overall: 0 },
      event_cnt: 141,
      entity: {
        code: '45609-1774',
        name: hostile,
        subnames: [],
        type: 'geoasn',
        attrs: { fqid: 'geoasn.45609-1774', org: hostile },
      },
      rank: { note: [hostile, null] },
    };
    network(() => envelope([row]));
    const data = parity(
      await runToolContract(summarizeOutages, { ...window, entityType: 'geoasn' }),
    );
    expect(data.summaries).toEqual([row]);
  });
  it.each([
    ['a missing overall', { scores: { 'bgp.median': 1 }, event_cnt: 1, entity }],
    ['a string overall', { scores: { overall: '1' }, event_cnt: 1, entity }],
    ['a null source score', { scores: { overall: 1, 'bgp.median': null }, event_cnt: 1, entity }],
    ['a fractional event_cnt', { scores: { overall: 1 }, event_cnt: 1.5, entity }],
    ['a missing entity', { scores: { overall: 1 }, event_cnt: 1 }],
  ])('rejects a row with %s as upstream_schema', async (_, row) => {
    network(() => envelope([row]));
    const result = await runToolContract(summarizeOutages, { ...window, entityType: 'country' });
    const error = failure(result, JsonRpcErrorCode.SerializationError, 'upstream_schema');
    expect(error.data?.recovery?.hint).toBe(
      'Retry ioda_summarize_outages once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    );
  });
  it('scores one entityCode, and a related scope whose full page continues', async () => {
    network(() => envelope([iran]));
    let data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'country',
        entityCode: ' ir ',
      }),
    );
    expect(query(calls[0])).toEqual({
      ...seconds,
      entityType: 'country',
      entityCode: 'IR',
      extendWindow: '1209600',
      limit: '20',
      page: '0',
    });
    expect(data.summaries).toEqual([iran]);
    expect(data.applied).toMatchObject({
      entityType: 'country',
      entityCode: 'IR',
      scope: 'entity',
    });

    network(() => envelope(iranRegions));
    data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        relatedToType: ' Country ',
        relatedToCode: 'ir',
        limit: 3,
      }),
    );
    expect(query(calls[1])).toEqual({
      ...seconds,
      entityType: 'region',
      relatedTo: 'country/IR',
      extendWindow: '1209600',
      limit: '3',
      page: '0',
    });
    expect(data.summaries).toEqual(iranRegions);
    expect(data.applied).toEqual({
      entityType: 'region',
      relatedToType: 'country',
      relatedToCode: 'IR',
      ...window,
      extendWindowSeconds: 1209600,
      limit: 3,
      page: 0,
      scope: 'related',
      order,
    });
    expect(data.pagination).toEqual({
      page: 0,
      limit: 3,
      returned: 3,
      more: 'possible',
      nextPage: 1,
    });
    expect(rowGuidance(data.notice)).toBe(nextPage);

    network(() => envelope(iranRegions.slice(2)));
    data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        relatedToType: 'country',
        relatedToCode: 'IR',
        limit: 2,
        page: 1,
      }),
    );
    expect(query(calls[2])).toMatchObject({ relatedTo: 'country/IR', limit: '2', page: '1' });
    expect(data.pagination).toEqual({ page: 1, limit: 2, returned: 1, more: 'no' });
    expect(rowGuidance(data.notice)).toBeUndefined();
  });
  it.each([
    [
      'an entityCode',
      { entityType: 'asn', entityCode: 'AS15169', extendWindowSeconds: 0 },
      `${zeroHit} ${verify}`,
    ],
    ['a type-only ranking', { entityType: 'asn' }, zeroHit],
    [
      'a related scope',
      { entityType: 'region', relatedToType: 'country', relatedToCode: 'ZZ' },
      `${zeroHit} ${verifyScope}`,
    ],
    [
      'a later page with an entityCode',
      { entityType: 'country', entityCode: 'ZZ', page: 1 },
      pastEnd,
    ],
    ['a later type-only page', { entityType: 'country', page: 4 }, pastEnd],
  ])('answers an empty page for %s without an all-clear', async (_, filters, notice) => {
    network(() => envelope([]));
    const data = parity(await runToolContract(summarizeOutages, { ...window, ...filters }));
    expect(calls).toHaveLength(1);
    expect(data.summaries).toEqual([]);
    expect(data.pagination).toEqual({
      page: 'page' in filters ? filters.page : 0,
      limit: 20,
      returned: 0,
      more: 'no',
    });
    expect(data.truncated).toBeUndefined();
    expect(rowGuidance(data.notice)).toBe(notice);
  });
  it('sends an explicit zero extension unchanged', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'asn',
        entityCode: '15169',
        extendWindowSeconds: 0,
      }),
    );
    expect(query(calls[0])).toEqual({
      ...seconds,
      entityType: 'asn',
      entityCode: '15169',
      extendWindow: '0',
      limit: '20',
      page: '0',
    });
    expect(data.applied).toMatchObject({ extendWindowSeconds: 0 });
  });
  it('serves limit 100 and a 1209600 extension unchanged, and over-cap values at the caps with notices', async () => {
    network(() => envelope([]));
    let data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        limit: 100,
        extendWindowSeconds: 1209600,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '100', extendWindow: '1209600' });
    expect(data.notice).toBe(zeroHit);

    network(() => envelope([]));
    data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        limit: 1000,
        extendWindowSeconds: 12096000,
        page: 2,
      }),
    );
    expect(query(calls[1])).toMatchObject({ limit: '100', extendWindow: '1209600', page: '2' });
    expect(data.applied).toMatchObject({ limit: 100, extendWindowSeconds: 1209600, page: 2 });
    expect(data.notice).toBe(
      `limit 1000 exceeds the cap of 100; served 100. Page 2 starts after the first 200 records. Every limit from 100 to 1000 serves the same pages. extendWindowSeconds 12096000 exceeds the cap of 1209600; served 1209600. Events overlapping the window that began more than 1209600 seconds before from are not counted, or are counted from a later start. To check one entity for such an event, call ioda_find_outages with this entityType, that entity's code as entityCode, from 1789858801, until 1792537201, and extendWindowSeconds 1209600, then keep only the events whose until is at or after 1792537200. ${pastEnd}`,
    );
  });
  it.each([
    [{ entityType: 'region', limit: 1001 }, 'limit: Too big: expected number to be <=1000'],
    [
      { entityType: 'region', extendWindowSeconds: -1 },
      'extendWindowSeconds: Too small: expected number to be >=0',
    ],
    [
      { entityType: 'region', extendWindowSeconds: 12096001 },
      'extendWindowSeconds: Too big: expected number to be <=12096000',
    ],
  ])('rejects %j outside the schema before HTTP', async (input, bound) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const error = failure(
      await runToolContract(summarizeOutages, { ...window, ...input }),
      JsonRpcErrorCode.InvalidParams,
    );
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message.endsWith(`: ${bound}`)).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('fails argument validation without an entityType before HTTP', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    // @ts-expect-error entityType is required: IODA ranks one entity type at a time.
    const result = await runToolContract(summarizeOutages, window);
    const error = failure(result, JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(
      error.message.endsWith(': entityType: Invalid input: expected string, received undefined'),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it.each([
    [{ entityType: '  ' }, 'entityType', lexicalTypeMessage],
    [{ entityType: 'continent' }, 'entityType', lexicalTypeMessage],
    [{ entityType: ' ', entityCode: 'IR' }, 'entityType', lexicalTypeMessage],
    [
      { entityType: ' ', relatedToType: 'country', relatedToCode: 'IR' },
      'entityType',
      lexicalTypeMessage,
    ],
    [{ entityType: 'country', entityCode: 'IRN' }, 'entityCode', lexicalCodeMessage],
    [{ entityType: 'geoasn', entityCode: '40934-USA' }, 'entityCode', lexicalCodeMessage],
  ])(
    'rejects lexical entity %j with invalid_arguments before HTTP',
    async (input, field, message) => {
      network(() => {
        throw new Error('unexpected network');
      });
      const result = await runToolContract(summarizeOutages, { ...window, ...input });
      lexicalFailure(result, 'ioda_summarize_outages', field, message);
      expect(calls).toHaveLength(0);
    },
  );
  it('answers a blank entityType with a scope as search does, while find_outages keeps the scope error', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const blank = { entityType: ' ', relatedToType: 'country', relatedToCode: 'IR' };
    for (const [name, result] of [
      ['ioda_search_entities', await runToolContract(searchEntities, blank)],
      ['ioda_summarize_outages', await runToolContract(summarizeOutages, { ...window, ...blank })],
    ] as const) {
      lexicalFailure(result, name, 'entityType', lexicalTypeMessage);
    }
    const events = failure(
      await runToolContract(findOutages, { ...window, ...blank }),
      JsonRpcErrorCode.ValidationError,
      'invalid_scope',
    );
    expect(events.message).toBe(
      'A relatedTo scope requires entityType, the type of entity to list within it; without it IODA matches codes across entity types.',
    );
    expect(calls).toHaveLength(0);
  });
  it.each([
    [
      { entityType: 'region', relatedToType: 'country' },
      'relatedToType and relatedToCode go together; provide both, or omit both for no scope.',
    ],
    [
      { entityType: 'region', relatedToCode: 'IR' },
      'relatedToType and relatedToCode go together; provide both, or omit both for no scope.',
    ],
    [
      { entityType: 'asn', relatedToType: 'region', relatedToCode: '0' },
      'relatedToCode does not fit relatedToType region: ASN must be 1–4294967295; region codes must be positive.',
    ],
    [
      { entityType: 'region', entityCode: '1829', relatedToType: 'country', relatedToCode: 'IR' },
      'A relatedTo scope lists every entityType entity within it, so it cannot be combined with entityCode; omit entityCode to use the scope.',
    ],
  ])('rejects scope %j with invalid_scope before HTTP', async (input, message) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(summarizeOutages, { ...window, ...input });
    const error = failure(result, JsonRpcErrorCode.ValidationError, 'invalid_scope');
    expect(error.message).toBe(message);
    expect(error.data?.recovery?.hint).toBe(recoveries.invalid_scope);
    expect(text(result)).toContain(`Error: ${message}`);
    expect(calls).toHaveLength(0);
  });
  it('rejects a reversed window with invalid_window before HTTP', async () => {
    network(() => {
      throw new Error('unexpected network');
    });
    const result = await runToolContract(summarizeOutages, {
      from: window.until,
      until: window.from,
      entityType: 'country',
    });
    const error = failure(result, JsonRpcErrorCode.ValidationError, 'invalid_window');
    expect(error.message).toBe('from 1792540800 is not before until 1792537200.');
    expect(error.data?.recovery?.hint).toBe(
      'Call ioda_summarize_outages with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows; shared boundaries can duplicate detections.',
    );
    expect(calls).toHaveLength(0);
  });
  it('reports a ranking over the 96 KiB budget with the smaller-limit route', async () => {
    const wide = Array.from({ length: 100 }, (_, index) =>
      country(String(index), 'x'.repeat(600), `geo.${index}`, { overall: 100 - index }, 1),
    );
    network(() => envelope(wide));
    const result = await runToolContract(summarizeOutages, {
      ...window,
      entityType: 'region',
      limit: 100,
    });
    const error = failure(result, JsonRpcErrorCode.ValidationError, 'response_too_large');
    expect(error.message).toBe('IODA result exceeded the 96 KiB combined response budget.');
    expect(error.data?.recovery?.hint).toBe(
      'Call ioda_summarize_outages with a smaller limit and page 0, then continue with that fixed limit.',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('hostile Markdown fence bounds', () => {
  it('enforces the independently measured assembled 96 KiB boundary including multibyte enrichment', async () => {
    const odd = ['', ''];
    const run = async (padding: number, marker?: unknown[]) => {
      network(() =>
        envelope([{ code: 'US', name: `雪${'x'.repeat(padding)}`, ...(marker && { x: marker }) }]),
      );
      return runToolContract(searchEntities, { entityType: 'country', limit: 1 });
    };
    const baseline = await run(0);
    parity(baseline);
    const measure = (result: Result) =>
      new TextEncoder().encode(JSON.stringify(result.structuredContent)).byteLength +
      result.content.reduce(
        (bytes, block) =>
          bytes + (block.type === 'text' ? new TextEncoder().encode(block.text).byteLength : 0),
        0,
      );
    const ceiling = 96 * 1024;
    const padding = Math.floor((ceiling - measure(baseline)) / 2);
    const below = await run(padding);
    parity(below);
    expect(measure(below)).toBe(ceiling);
    failure(await run(padding + 1), JsonRpcErrorCode.ValidationError, 'response_too_large');
    const oddBaseline = await run(0, odd);
    const oddPadding = Math.floor((ceiling - measure(oddBaseline)) / 2);
    const immediatelyBelow = await run(oddPadding, odd);
    parity(immediatelyBelow);
    expect(measure(immediatelyBelow)).toBe(ceiling - 1);
    failure(await run(oddPadding + 1, odd), JsonRpcErrorCode.ValidationError, 'response_too_large');
    const numbers = Array.from({ length: 200 }, (_, index) => (index % 7 ? index : null));
    const numericBaseline = await run(0, numbers);
    const numericPadding = Math.floor((ceiling - measure(numericBaseline)) / 2);
    const numericBelow = await run(numericPadding, numbers);
    parity(numericBelow);
    expect(text(numericBelow)).toContain(`"x": ${JSON.stringify(numbers)}`);
    expect(measure(numericBelow)).toBe(ceiling - ((ceiling - measure(numericBaseline)) % 2));
    failure(
      await run(numericPadding + 1, numbers),
      JsonRpcErrorCode.ValidationError,
      'response_too_large',
    );
  });
  it('renders arrays of only numbers and nulls on one line and every other array one item per line', () => {
    expect(renderJson({ values: [1, null, 2.5, -0.001], empty: [], none: {} })).toBe(
      '```json\n{\n  "values": [1,null,2.5,-0.001],\n  "empty": [],\n  "none": {}\n}\n```',
    );
    expect(
      renderJson({
        grid: [[1, 2], [], [[4]]],
        words: ['a', 'b'],
        items: [{ a: [null] }],
        mixed: [1, 'two', true],
        flags: [true, false],
      }),
    ).toBe(
      [
        '```json',
        '{',
        '  "grid": [',
        '    [1,2],',
        '    [],',
        '    [',
        '      [4]',
        '    ]',
        '  ],',
        '  "words": [',
        '    "a",',
        '    "b"',
        '  ],',
        '  "items": [',
        '    {',
        '      "a": [null]',
        '    }',
        '  ],',
        '  "mixed": [',
        '    1,',
        '    "two",',
        '    true',
        '  ],',
        '  "flags": [',
        '    true,',
        '    false',
        '  ]',
        '}',
        '```',
      ].join('\n'),
    );
  });
  it('round-trips numeric, empty, nested, string and object arrays through both surfaces', async () => {
    const attrs = {
      numbers: [1, null, 2.5, -0.001, 1e-7, 1.7976931348623157e308, null, 0],
      allNull: [null, null],
      empty: [],
      nested: [[1, 2], [3, null], [], [[4]]],
      strings: ['q"uote', 'comma, here', 'line\nbreak\r\n\t', '````', '`x`', ''],
      objects: [{ a: [1, 2], b: hostile }, { c: null }, [5, { d: [null] }]],
    };
    network(() => envelope([{ code: 'US', name: 'US', attrs }]));
    const result = await runToolContract(searchEntities, { entityType: 'country' });
    const data = parity(result);
    expect(data.entities).toEqual([{ code: 'US', name: 'US', attrs }]);
    const lines = text(result).split('\n');
    expect(lines[2]).toBe('`````json');
    expect(lines).toContain(
      '        "numbers": [1,null,2.5,-0.001,1e-7,1.7976931348623157e+308,null,0],',
    );
    expect(lines).toContain('        "strings": [');
    expect(lines).toContain('          "comma, here",');
  });
  it('keeps series values on one line and status limitations and components one item per line', async () => {
    const series = {
      entityType: 'country',
      entityCode: 'US',
      datasource: 'bgp',
      from: window.from,
      until: window.until,
      step: 1800,
      nativeStep: 300,
      values: [7, null],
    };
    network(() => envelope([[series]]));
    const signals = await runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp' });
    parity(signals);
    expect(text(signals).split('\n')).toContain('      "values": [7,null]');
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    const pending = runToolContract(getStatus, entityInput);
    await vi.advanceTimersByTimeAsync(9000);
    const status = await pending;
    const data = parity(status);
    const lines = text(status).split('\n');
    const limitations = lines.indexOf('  "limitations": [');
    const items = data.limitations as string[];
    expect(items.length).toBeGreaterThan(1);
    expect(lines.slice(limitations + 1, limitations + 1 + items.length)).toEqual(
      items.map(
        (item, index) => `    ${JSON.stringify(item)}${index < items.length - 1 ? ',' : ''}`,
      ),
    );
    const components = lines.indexOf('  "components": [');
    expect(components).toBeGreaterThan(0);
    expect(lines[components + 1]).toBe('    {');
  });
  /** Smallest thread CPU time of three renders, after a warm-up render of the same value. */
  const cpu = (value: unknown) => {
    let ms = Number.POSITIVE_INFINITY;
    let bytes = renderJson(value).length;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      bytes = renderJson(value).length;
      const used = process.threadCpuUsage(start);
      ms = Math.min(ms, (used.user + used.system) / 1000);
    }
    return { ms, bytes };
  };
  it.each([
    ['one long line ending in a break', (n: number) => ({ text: [`${'§1 x'.repeat(n / 4)}\ny`] })],
    [
      'breaks throughout',
      (n: number) => ({ text: '  \r\n'.repeat(n / 8), lines: Array(n / 8).fill('  \r\n') }),
    ],
    [
      'numeric series',
      (n: number) => ({ values: Array.from({ length: n / 4 }, (_, i) => (i % 5 ? i : null)) }),
    ],
    [
      'sibling arrays and objects',
      (n: number) => ({
        rows: Array.from({ length: n / 16 }, (_, i) => [i, [i, null], { k: [] }]),
      }),
    ],
  ])(
    'renderJson timing stays linear for %s from 5k to 320k characters',
    (_, shape) => {
      const samples: number[] = [];
      for (let n = 5120; n <= 327680; n *= 2) {
        const { ms } = cpu(shape(n));
        expect(ms).toBeLessThan(2000);
        samples.push(ms);
      }
      expect(samples).toHaveLength(7);
      expect((samples.at(-1) ?? 0) / Math.max(samples[0] ?? 0, 0.05)).toBeLessThan(256);
    },
    60_000,
  );
  it('renderJson timing stays linear in its output for nested openers', () => {
    const nest = (depth: number) => {
      let value: unknown = ['x'];
      for (let level = 0; level < depth; level++) value = [value, 'y'];
      return value;
    };
    const perByte: number[] = [];
    for (let depth = 64; depth <= 4096; depth *= 2) {
      const { ms, bytes } = cpu(nest(depth));
      expect(ms).toBeLessThan(2000);
      perByte.push(ms / bytes);
    }
    expect(perByte).toHaveLength(7);
    expect((perByte.at(-1) ?? 0) / (perByte[3] ?? 1)).toBeLessThan(8);
  }, 60_000);
  it('handles many separate backtick runs without a spread argument overflow', () => {
    const value = { text: '`x'.repeat(150000), nested: { text: '````\r\n雪' } };
    const rendered = renderJson(value);
    const lines = rendered.split('\n');
    expect(lines[0]).toBe('`````json');
    expect(JSON.parse(lines.slice(1, -1).join('\n'))).toEqual(value);
  });
});
