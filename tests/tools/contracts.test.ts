/**
 * @fileoverview Public IODA contracts exercised through the injected HTTP boundary.
 * @module tests/tools/contracts
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { type MeterProvider, metrics } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOutages } from '../../src/mcp-server/tools/definitions/find-outages.tool.js';
import { getAlerts } from '../../src/mcp-server/tools/definitions/get-alerts.tool.js';
import { getSignals } from '../../src/mcp-server/tools/definitions/get-signals.tool.js';
import { getStatus } from '../../src/mcp-server/tools/definitions/get-status.tool.js';
import { searchEntities } from '../../src/mcp-server/tools/definitions/search-entities.tool.js';
import { summarizeOutages } from '../../src/mcp-server/tools/definitions/summarize-outages.tool.js';
import {
  archiveNotice,
  archivePosition,
  cappedInput,
  clampExtendWindow,
  clampLimit,
  clampLookbackHours,
  clampMaxPoints,
  composeEnrichment,
  entityFilter,
  isPlaceholderRegion,
  placeholderRegionNotice,
  relatedScope,
  renderJson,
  SERVED_CAPS,
  validateWindow,
} from '../../src/mcp-server/tools/ioda-common.js';
import { type IodaReason, recoveryFor } from '../../src/services/ioda/errors.js';
import {
  AlertSchema,
  disposeIodaService,
  initIodaService,
  ProvenanceSchema,
} from '../../src/services/ioda/index.js';

const now = 1792540800000;
const window = { from: now / 1000 - 3600, until: now / 1000 };
const seconds = { from: String(window.from), until: String(window.until) };
const nextPage =
  'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.';
const query = (url: URL | undefined) => Object.fromEntries(url?.searchParams ?? []);
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
/** IODA's /datasources units for the three core sources ioda_get_status collects, verbatim. */
const units = {
  bgp: 'Visible /24s',
  'ping-slash24': 'Up /24s',
  'merit-nt': 'Unique Source IPs',
} as const;
/** ioda_get_signals also serves gtr, in IODA's /datasources unit for it. */
const signalUnits = { ...units, gtr: 'Traffic' } as const;
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
                    [' GTR ', true],
                    ['gtr-norm', false],
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
    const ctx = createMockContext();
    expect(SERVED_CAPS).toStrictEqual({
      limit: 1000,
      maxPoints: 10000,
      lookbackHours: 24,
      extendWindowSeconds: 1209600,
    });
    expect(clampLimit(1000, 5, ctx, 'ioda_find_outages')).toStrictEqual({ value: 1000 });
    expect(clampLimit(1001, 0, ctx, 'ioda_find_outages')).toStrictEqual({
      value: 1000,
      notice:
        'limit 1001 exceeds the cap of 1000; served 1000. Every limit of 1000 or more serves the same pages.',
    });
    expect(clampLimit(1500, 2, ctx, 'ioda_get_alerts')).toStrictEqual({
      value: 1000,
      notice:
        'limit 1500 exceeds the cap of 1000; served 1000. Page 2 starts after the first 2000 records. Every limit of 1000 or more serves the same pages.',
    });
    expect(clampMaxPoints(10000, ctx)).toStrictEqual({ value: 10000 });
    expect(clampMaxPoints(10001, ctx)).toStrictEqual({
      value: 10000,
      notice:
        'maxPoints 10001 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation.',
    });
    expect(clampLookbackHours(24, asOf, ctx)).toStrictEqual({ value: 24 });
    expect(clampLookbackHours(240, asOf, ctx)).toStrictEqual({
      value: 24,
      notice:
        'lookbackHours 240 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from 1791676800 and until 1792454400.',
    });
    expect(clampExtendWindow(0, 'ioda_find_outages', window, now, ctx)).toStrictEqual({
      value: 0,
    });
    expect(clampExtendWindow(1209600, 'ioda_find_outages', window, now, ctx)).toStrictEqual({
      value: 1209600,
    });
  });
  it.each([25, 240, 768, 769, 2000])(
    'names an uncovered lookbackHours %i window that validates, at most 31 days ending at the served window',
    (requested) => {
      const asOf = now / 1000;
      const notice = clampLookbackHours(requested, asOf, createMockContext()).notice ?? '';
      const [, from, until] = /from (\d+) and until (\d+)/.exec(notice) ?? [];
      const uncovered = { from: Number(from), until: Number(until) };
      expect(uncovered.until).toBe(asOf - 86400);
      expect(uncovered.until - uncovered.from).toBe(Math.min((requested - 24) * 3600, 2678400));
      expect(() => validateWindow(uncovered, now)).not.toThrow();
    },
  );
  it('names an uncovered window of exactly 31 days as one call, not as over the limit', () => {
    expect(clampLookbackHours(768, now / 1000, createMockContext()).notice).toBe(
      'lookbackHours 768 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from 1789776000 and until 1792454400.',
    );
  });
  it.each([1.5, 20.000000000000004])(
    'rejects limit %d with exactly one whole-number issue',
    (value) => {
      const parsed = cappedInput('limit', 1).safeParse(value);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
        'Use a whole number for limit.',
      ]);
    },
  );
  it.each([1.5, 20.000000000000004])(
    'fails limit %d as invalid_arguments naming the whole-number rule before HTTP',
    async (limit) => {
      network(() => {
        throw new Error('unexpected network');
      });
      const error = failure(
        await runToolContract(searchEntities, { entityType: 'region', limit }),
        JsonRpcErrorCode.InvalidParams,
      );
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toBe(
        'Input validation error: Invalid arguments for tool ioda_search_entities: limit: Use a whole number for limit.',
      );
      expect((error.data as { issues?: unknown[] }).issues).toHaveLength(1);
      expect(calls).toHaveLength(0);
    },
  );
  it('serves a whole limit of 2**60 at the cap', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(searchEntities, { entityType: 'region', limit: 2 ** 60 }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '1000' });
    expect(data.applied).toMatchObject({ limit: 1000 });
    // 2 ** 60 prints as its shortest round-trip decimal, as JSON.stringify writes it.
    expect(data.notice).toBe(
      'limit 1152921504606847000 exceeds the cap of 1000; served 1000. Every limit of 1000 or more serves the same pages. IODA lists no region entities.',
    );
  });
  it('logs each clamp with tool, input, requested and served, and nothing at the cap', () => {
    const ctx = createMockContext();
    const log = ctx.log as MockContextLogger;
    clampLimit(1000, 0, ctx, 'ioda_find_outages');
    clampMaxPoints(10000, ctx);
    clampLookbackHours(24, now / 1000, ctx);
    clampExtendWindow(1209600, 'ioda_get_alerts', window, now, ctx);
    expect(log.calls).toEqual([]);
    clampLimit(5000, 3, ctx, 'ioda_find_outages');
    clampMaxPoints(10001, ctx);
    clampLookbackHours(25, now / 1000, ctx);
    clampExtendWindow(1209601, 'ioda_get_alerts', window, now, ctx);
    const served = (tool: string, input: string, requested: number, cap: number) => ({
      level: 'info',
      msg: `Served ${input} at its cap`,
      data: { tool, input, requested, served: cap },
    });
    expect(log.calls).toEqual([
      served('ioda_find_outages', 'limit', 5000, 1000),
      served('ioda_get_signals', 'maxPoints', 10001, 10000),
      served('ioda_get_status', 'lookbackHours', 25, 24),
      served('ioda_get_alerts', 'extendWindowSeconds', 1209601, 1209600),
    ]);
  });
  it('counts each clamp labelled by tool and input name, never the requested value', async () => {
    const created: unknown[][] = [];
    const added: unknown[][] = [];
    const meter = {
      createCounter: (...args: unknown[]) => {
        created.push(args);
        return { add: (...values: unknown[]) => added.push(values) };
      },
    };
    expect(
      metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider),
    ).toBe(true);
    try {
      // A fresh module, so its counter is created on the first clamp from the provider above.
      vi.resetModules();
      const fresh = await import('../../src/mcp-server/tools/ioda-common.js');
      const ctx = createMockContext();
      fresh.clampLimit(1000, 0, ctx, 'ioda_find_outages');
      expect(created).toEqual([]);
      fresh.clampLimit(5000, 3, ctx, 'ioda_find_outages');
      fresh.clampMaxPoints(10001, ctx);
      fresh.clampLookbackHours(25, now / 1000, ctx);
      fresh.clampExtendWindow(1209601, 'ioda_summarize_outages', window, now, ctx);
      expect(created).toEqual([
        [
          'ioda.input.clamps',
          { description: 'Over-cap inputs served at their cap', unit: '{clamps}' },
        ],
      ]);
      expect(added).toEqual([
        [1, { 'mcp.tool.name': 'ioda_find_outages', 'ioda.input.name': 'limit' }],
        [1, { 'mcp.tool.name': 'ioda_get_signals', 'ioda.input.name': 'maxPoints' }],
        [1, { 'mcp.tool.name': 'ioda_get_status', 'ioda.input.name': 'lookbackHours' }],
        [
          1,
          { 'mcp.tool.name': 'ioda_summarize_outages', 'ioda.input.name': 'extendWindowSeconds' },
        ],
      ]);
    } finally {
      metrics.disable();
      vi.resetModules();
    }
  });
  it('declares only argument reasons and the service failure surface on every tool', () => {
    /** Every IodaReason, so adding one to the service fails typecheck until it is listed here. */
    const service: Record<IodaReason, true> = {
      upstream_bad_request: true,
      upstream_unprocessable: true,
      entity_not_found: true,
      upstream_rate_limited: true,
      upstream_queue_full: true,
      upstream_schema: true,
      upstream_unavailable: true,
      upstream_timeout: true,
      upstream_unauthorized: true,
      upstream_forbidden: true,
      request_cancelled: true,
    };
    const definitions = [
      searchEntities,
      getStatus,
      findOutages,
      summarizeOutages,
      getSignals,
      getAlerts,
    ];
    /** The argument reasons handlers throw before any request; a new one is reviewed here. */
    const argument = new Set([
      'invalid_entity',
      'invalid_scope',
      'invalid_window',
      'invalid_ignore_methods',
      'conflicting_search',
    ]);
    for (const definition of definitions) {
      expect(definition.errors?.length, definition.name).toBeGreaterThan(0);
      for (const { reason } of definition.errors ?? [])
        expect(
          argument.has(reason) || Object.hasOwn(service, reason),
          `${definition.name} declares ${reason}`,
        ).toBe(true);
    }
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
      expect(clampExtendWindow(requested, tool, bounds, now, createMockContext())).toStrictEqual({
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
        const notice =
          clampExtendWindow(requested, tool, bounds, now, createMockContext()).notice ?? '';
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
      envelope(Array.from({ length: 1000 }, (_, index) => ({ code: String(index), name: 'r' }))),
    );
    const data = parity(
      await runToolContract(searchEntities, { entityType: 'region', limit: 1500, page: 1 }),
    );
    expect(query(calls[0])).toEqual({ entityType: 'region', limit: '1000', page: '1' });
    expect(data.applied).toEqual({ entityType: 'region', limit: 1000, page: 1 });
    expect(data.pagination).toEqual({
      page: 1,
      limit: 1000,
      returned: 1000,
      more: 'possible',
      nextPage: 2,
    });
    expect(data.truncated).toEqual({ shown: 1000, cap: 1000 });
    expect(data.notice).toBe(
      `limit 1500 exceeds the cap of 1000; served 1000. Page 1 starts after the first 1000 records. Every limit of 1000 or more serves the same pages. ${nextPage}`,
    );
  });
  it('serves over-cap event limit and extension and composes them with the empty-page notice', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(findOutages, {
        ...window,
        ...entityInput,
        limit: 1001,
        extendWindowSeconds: 12096000,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '1000', extendWindow: '1209600', page: '0' });
    expect(data.applied).toMatchObject({ limit: 1000, extendWindowSeconds: 1209600 });
    expect(data.pagination).toEqual({ page: 0, limit: 1000, returned: 0, more: 'no' });
    expect(data.truncated).toBeUndefined();
    expect(data.notice).toBe(
      'limit 1001 exceeds the cap of 1000; served 1000. Every limit of 1000 or more serves the same pages. extendWindowSeconds 12096000 exceeds the cap of 1209600; served 1209600. An event overlapping the window that began more than 1209600 seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with from 1789858801, until 1792537201, extendWindowSeconds 1209600, and the other filters unchanged, then keep only the events whose until is at or after 1792537200. No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear. IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.',
    );
  });
  it('serves over-cap alert limit and extension on a past-end page', async () => {
    network(() => envelope([]));
    const data = parity(
      await runToolContract(getAlerts, {
        ...window,
        limit: 1001,
        extendWindowSeconds: 1209601,
        page: 3,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '1000', extendWindow: '1209600', page: '3' });
    expect(data.applied).toMatchObject({ limit: 1000, extendWindowSeconds: 1209600, page: 3 });
    expect(data.pagination).toEqual({ page: 3, limit: 1000, returned: 0, more: 'no' });
    expect(data.notice).toBe(
      'limit 1001 exceeds the cap of 1000; served 1000. Page 3 starts after the first 3000 records. Every limit of 1000 or more serves the same pages. extendWindowSeconds 1209601 exceeds the cap of 1209600; served 1209600. Transitions more than 1209600 seconds before from are not returned. To reach them, call ioda_get_alerts at page 0 with from 1792537199, until 1792540800, extendWindowSeconds 1209600, and the other filters unchanged. This page is empty. Call ioda_get_alerts with page 0 and unchanged filters, or return to the previous page.',
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
  it('serves over-cap maxPoints at 10000 alone and composed with the empty-series notice', async () => {
    // Complete buckets ending two hours before the call, so no publication notice joins these.
    const earlier = { from: window.from - 7200, until: window.until - 7200 };
    const series = {
      entityType: 'country',
      entityCode: 'US',
      datasource: 'bgp',
      ...earlier,
      step: 1800,
      nativeStep: 300,
      values: [1, 2],
    };
    const clamp =
      'maxPoints 20000 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation.';
    network(() => envelope([[series]]));
    const input = { ...earlier, ...entityInput, source: 'bgp', maxPoints: 20000 };
    let data = parity(await runToolContract(getSignals, input));
    expect(query(calls[0])).toEqual({
      from: String(earlier.from),
      until: String(earlier.until),
      datasource: 'bgp',
      maxPoints: '10000',
    });
    expect(data.applied).toEqual({ ...earlier, ...entityInput, source: 'bgp', maxPoints: 10000 });
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
      'maxPoints: Too small: expected number to be >=1',
      () => runToolContract(getSignals, { ...signal, maxPoints: 0 }),
    ],
    [
      'lookbackHours: Too small: expected number to be >=1',
      () => runToolContract(getStatus, { ...entityInput, lookbackHours: 0 }),
    ],
    [
      'extendWindowSeconds: Too small: expected number to be >=0',
      () => runToolContract(findOutages, { ...window, extendWindowSeconds: -1 }),
    ],
  ])('still rejects below the schema minimum before HTTP: %s', async (bound, run) => {
    network(() => {
      throw new Error('unexpected network');
    });
    const error = failure(await run(), JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message.endsWith(`: ${bound}`)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('whole pages at the served caps', () => {
  const day = { from: window.until - 86400, until: window.until };
  /** An asn event about as wide as IODA's, with its detection and recovery transitions. */
  function asnEvent(index: number) {
    const network = {
      code: String(64500 + index),
      name: `AS${64500 + index} ${'n'.repeat(48)}`,
      type: 'asn',
      attrs: { org: 'o'.repeat(64), fqid: `asn.${64500 + index}` },
    };
    const transition = (level: string, time: number) => ({
      entity: network,
      datasource: 'ping-slash24',
      time,
      level,
      condition: '< 0.8',
      value: 120 + index,
      historyValue: 300,
      method: 'ping-slash24.median',
    });
    return {
      entity: network,
      from: day.from - 600,
      until: day.until,
      score: 1000 + index,
      datasource: 'ping-slash24',
      method: 'ping-slash24.median',
      alerts: [transition('critical', day.from - 600), transition('normal', day.until)],
    };
  }
  /** IODA's rows for the forwarded page and limit over `total` rows. */
  function paged(total: number, row: (index: number) => unknown) {
    return (url: URL) => {
      const limit = Number(url.searchParams.get('limit'));
      const page = Number(url.searchParams.get('page'));
      const count = Math.max(0, Math.min(limit, total - page * limit));
      return envelope(Array.from({ length: count }, (_, index) => row(page * limit + index)));
    };
  }
  function measure(result: Result) {
    const encoder = new TextEncoder();
    return (
      encoder.encode(JSON.stringify(result.structuredContent)).byteLength +
      result.content.reduce(
        (bytes, block) =>
          bytes + (block.type === 'text' ? encoder.encode(block.text).byteLength : 0),
        0,
      )
    );
  }
  it('returns a one-day asn page of 100 events with nested alerts whole on both surfaces', async () => {
    network(paged(683, asnEvent));
    const result = await runToolContract(findOutages, {
      ...day,
      entityType: 'asn',
      limit: 100,
      includeAlerts: true,
    });
    const data = parity(result);
    expect(data.events).toEqual(Array.from({ length: 100 }, (_, index) => asnEvent(index)));
    expect(query(calls[0])).toMatchObject({
      entityType: 'asn',
      includeAlerts: 'true',
      limit: '100',
      page: '0',
    });
    expect(data.pagination).toEqual({
      page: 0,
      limit: 100,
      returned: 100,
      more: 'possible',
      nextPage: 1,
    });
    expect(data.notice).toBe(nextPage);
    expect(measure(result)).toBeGreaterThan(150_000);
  });
  it('forwards limit 1000 and each page unchanged, so a fixed-limit walk returns every row once', async () => {
    const row = (index: number) => ({
      entity: { code: String(index), name: 'n' },
      from: day.from,
      until: day.until,
      score: index,
      datasource: 'bgp',
    });
    const rows: unknown[] = [];
    for (const page of [0, 1, 2, 3]) {
      // A fresh service per call, so the shared pacer's start gap never waits on fake timers.
      network(paged(2100, row));
      const data = parity(
        await runToolContract(findOutages, { ...day, entityType: 'asn', limit: 1000, page }),
      );
      rows.push(...(data.events as unknown[]));
      const returned = [1000, 1000, 100, 0][page] ?? 0;
      expect(data.pagination).toEqual({
        page,
        limit: 1000,
        returned,
        more: returned === 1000 ? 'possible' : 'no',
        ...(returned === 1000 && { nextPage: page + 1 }),
      });
      expect(data.applied).toMatchObject({ limit: 1000, page });
    }
    expect(
      calls.map((url) => [url.searchParams.get('limit'), url.searchParams.get('page')]),
    ).toEqual([
      ['1000', '0'],
      ['1000', '1'],
      ['1000', '2'],
      ['1000', '3'],
    ]);
    expect(rows).toEqual(Array.from({ length: 2100 }, (_, index) => row(index)));
  });
  const named = (index: number) => ({ code: String(index), name: 'n' });
  const lists = [
    ['ioda_search_entities', searchEntities, {}, named],
    [
      'ioda_find_outages',
      findOutages,
      day,
      (index: number) => ({ entity: named(index), from: day.from, until: day.until, score: 1 }),
    ],
    [
      'ioda_summarize_outages',
      summarizeOutages,
      day,
      (index: number) => ({
        entity: named(index),
        scores: { overall: 2100 - index },
        event_cnt: 1,
      }),
    ],
    [
      'ioda_get_alerts',
      getAlerts,
      day,
      (index: number) => ({ entity: named(index), datasource: 'bgp', time: day.from }),
    ],
  ] as const;
  it.each(lists)(
    'serves %s at limit 1000 unchanged and 1001 at 1000 with a notice naming both',
    async (_, definition, bounds, row) => {
      const input = { ...bounds, entityType: 'asn' };
      network(paged(2100, row));
      let data = parity(await runToolContract(definition, { ...input, limit: 1000 }));
      expect(calls[0]?.searchParams.get('limit')).toBe('1000');
      expect(data.applied).toMatchObject({ limit: 1000 });
      expect(data.pagination).toMatchObject({ limit: 1000, returned: 1000 });
      expect(rowGuidance(data.notice)).toBe(nextPage);
      network(paged(2100, row));
      data = parity(await runToolContract(definition, { ...input, limit: 1001, page: 1 }));
      expect(calls[1]?.searchParams.get('limit')).toBe('1000');
      expect(calls[1]?.searchParams.get('page')).toBe('1');
      expect(data.applied).toMatchObject({ limit: 1000, page: 1 });
      expect(data.pagination).toMatchObject({ page: 1, limit: 1000, returned: 1000 });
      expect(data.truncated).toEqual({ shown: 1000, cap: 1000 });
      expect(rowGuidance(data.notice)).toBe(
        `limit 1001 exceeds the cap of 1000; served 1000. Page 1 starts after the first 1000 records. Every limit of 1000 or more serves the same pages. ${nextPage}`,
      );
    },
  );
  it('serves maxPoints 10000 unchanged and 10001 as 10000 with the same disclosure', async () => {
    network(() => envelope([[]]));
    const input = { ...window, ...entityInput, source: 'bgp' };
    let data = parity(await runToolContract(getSignals, { ...input, maxPoints: 10000 }));
    expect(calls[0]?.searchParams.get('maxPoints')).toBe('10000');
    expect(data.applied).toMatchObject({ maxPoints: 10000 });
    expect(data.notice).not.toMatch(/exceeds the cap/);
    network(() => envelope([[]]));
    data = parity(await runToolContract(getSignals, { ...input, maxPoints: 10001 }));
    expect(calls[1]?.searchParams.get('maxPoints')).toBe('10000');
    expect(data.applied).toMatchObject({ maxPoints: 10000 });
    expect(data.notice).toBe(
      'maxPoints 10001 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation. No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source or an earlier window. Missing data does not establish healthy connectivity.',
    );
  });
  it('serves lookbackHours 2000 as 24 and names the latest 31 days of the uncovered window as a call that validates', async () => {
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 2000 });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    const asOf = now / 1000;
    expect(data.window).toEqual({ from: asOf - 86400, until: asOf });
    expect(data.applied).toMatchObject({ lookbackHours: 24 });
    const until = asOf - 86400;
    const from = until - 2678400;
    expect(data.notice).toBe(
      `lookbackHours 2000 exceeds the cap of 24; served 24. The uncovered earlier window spans 1976 hours, over the 31-day window limit. For its latest 31 days, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from ${from} and until ${until}; for earlier hours back to from ${until - 1976 * 3600}, repeat with adjacent windows of at most 31 days, each ending at the previous from.`,
    );
    for (const [definition, extra] of [
      [findOutages, {}],
      [getAlerts, {}],
      [getSignals, { source: 'bgp' }],
    ] as const) {
      calls.length = 0;
      network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
      parity(await runToolContract(definition, { ...entityInput, ...extra, from, until }));
      expect(calls).toHaveLength(1);
      expect(query(calls[0])).toMatchObject({ from: String(from), until: String(until) });
    }
  });
  it.each([
    [searchEntities, 'limit'],
    [findOutages, 'limit'],
    [summarizeOutages, 'limit'],
    [getAlerts, 'limit'],
    [getSignals, 'maxPoints'],
    [getStatus, 'lookbackHours'],
    [findOutages, 'extendWindowSeconds'],
    [summarizeOutages, 'extendWindowSeconds'],
    [getAlerts, 'extendWindowSeconds'],
  ] as const)(
    'advertises %s.%s as a whole number with a minimum and no maximum',
    (definition, field) => {
      const schema = definition.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
      const property = (schema.properties as Record<string, Record<string, unknown>>)[field];
      expect(property).toMatchObject({
        type: 'integer',
        minimum: field === 'extendWindowSeconds' ? 0 : 1,
      });
      expect(property).not.toHaveProperty('maximum');
    },
  );
  const clampedLimit =
    'Default 20; a larger value returns at most 1000 and says so. Keep fixed when continuing.';
  it.each([
    ['ioda_search_entities', 'limit', searchEntities, clampedLimit],
    ['ioda_find_outages', 'limit', findOutages, clampedLimit],
    ['ioda_summarize_outages', 'limit', summarizeOutages, clampedLimit],
    ['ioda_get_alerts', 'limit', getAlerts, clampedLimit],
    [
      'ioda_get_signals',
      'maxPoints',
      getSignals,
      'Upstream aggregation target, not a local sample cap; smaller targets lose temporal resolution. Default 200; a value above 10000 is served as 10000 and says so.',
    ],
    [
      'ioda_get_status',
      'lookbackHours',
      getStatus,
      'Hours before the captured invocation time; values above 24 are served as 24 with a notice naming the uncovered earlier window. The exact window is returned.',
    ],
  ] as const)(
    'advertises the clamping description on %s.%s',
    (_, field, definition, description) => {
      const schema = definition.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
      expect((schema.properties as Record<string, Record<string, unknown>>)[field]).toMatchObject({
        description,
      });
    },
  );
});

describe('IODA_CLAMP_LIMITS=false', () => {
  const caps = { limit: 1000, maxPoints: 10000, lookbackHours: 24, extendWindowSeconds: 1209600 };
  /** Definitions from a fresh module graph, imported before the environment is parsed. */
  const strict = {} as {
    searchEntities: typeof searchEntities;
    findOutages: typeof findOutages;
    summarizeOutages: typeof summarizeOutages;
    getAlerts: typeof getAlerts;
    getSignals: typeof getSignals;
    getStatus: typeof getStatus;
  };
  let strictNetwork: (respond: (url: URL) => Response) => void = () => {};
  let disposeStrict = () => {};
  beforeAll(async () => {
    vi.resetModules();
    const [search, find, summarize, alerts, signals, status, service] = await Promise.all([
      import('../../src/mcp-server/tools/definitions/search-entities.tool.js'),
      import('../../src/mcp-server/tools/definitions/find-outages.tool.js'),
      import('../../src/mcp-server/tools/definitions/summarize-outages.tool.js'),
      import('../../src/mcp-server/tools/definitions/get-alerts.tool.js'),
      import('../../src/mcp-server/tools/definitions/get-signals.tool.js'),
      import('../../src/mcp-server/tools/definitions/get-status.tool.js'),
      import('../../src/services/ioda/index.js'),
    ]);
    Object.assign(strict, {
      searchEntities: search.searchEntities,
      findOutages: find.findOutages,
      summarizeOutages: summarize.summarizeOutages,
      getAlerts: alerts.getAlerts,
      getSignals: signals.getSignals,
      getStatus: status.getStatus,
    });
    strictNetwork = (respond) => {
      service.disposeIodaService();
      service.initIodaService({
        fetch: (async (input) => {
          const url = new URL(String(input));
          expect(url.origin).toBe('https://api.ioda.inetintel.cc.gatech.edu');
          calls.push(url);
          return respond(url);
        }) as typeof fetch,
      });
    };
    disposeStrict = service.disposeIodaService;
    // As setup() does after the definitions are imported; parsed once, so the stub can go.
    vi.stubEnv('IODA_CLAMP_LIMITS', 'false');
    (await import('../../src/config/server-config.js')).getServerConfig();
    vi.unstubAllEnvs();
  });
  afterEach(() => disposeStrict());
  afterAll(() => vi.resetModules());
  const minimal = {
    searchEntities: { entityType: 'region' },
    findOutages: window,
    summarizeOutages: { ...window, entityType: 'region' },
    getAlerts: window,
    getSignals: { ...window, ...entityInput, source: 'bgp' },
    getStatus: entityInput,
  };
  const limit = 'Default 20, at most 1000. Keep fixed when continuing.';
  const fields = [
    ['ioda_search_entities', 'searchEntities', 'limit', limit],
    ['ioda_find_outages', 'findOutages', 'limit', limit],
    ['ioda_summarize_outages', 'summarizeOutages', 'limit', limit],
    ['ioda_get_alerts', 'getAlerts', 'limit', limit],
    [
      'ioda_get_signals',
      'getSignals',
      'maxPoints',
      'Upstream aggregation target, not a local sample cap; smaller targets lose temporal resolution. Default 200, at most 10000.',
    ],
    [
      'ioda_get_status',
      'getStatus',
      'lookbackHours',
      'Hours before the captured invocation time; at most 24. The exact window is returned.',
    ],
    [
      'ioda_find_outages',
      'findOutages',
      'extendWindowSeconds',
      'Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; only overlapping events are returned. Defaults to 1209600 (14 days) with entityType and 86400 (one day) without it, because large global extensions can time out; the applied value is echoed. At most 1209600. Zero may miss long-running detections.',
    ],
    [
      'ioda_summarize_outages',
      'summarizeOutages',
      'extendWindowSeconds',
      "Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; defaults to 1209600 (14 days), IODA's default. At most 1209600. Large extensions on type-only rankings can time out; zero may miss long-running detections.",
    ],
    [
      'ioda_get_alerts',
      'getAlerts',
      'extendWindowSeconds',
      'Seconds before from and after until to also return transitions from; zero, the default, returns only transitions inside the window. Without entityType, large extensions are slow globally and can time out, so add entityType or keep the extension small. At most 1209600 (14 days).',
    ],
  ] as const;
  it.each(fields)(
    'advertises %s.%s with its cap as maximum and the strict description',
    (_, key, field, description) => {
      const schema = strict[key].input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
      expect((schema.properties as Record<string, Record<string, unknown>>)[field]).toMatchObject({
        type: 'integer',
        minimum: field === 'extendWindowSeconds' ? 0 : 1,
        maximum: caps[field],
        description,
      });
    },
  );
  it.each(fields)(
    'rejects %s.%s one over its cap before HTTP and forwards the cap unchanged',
    async (name, key, field) => {
      const cap = caps[field];
      const run = (value: number) =>
        runToolContract(strict[key], { ...minimal[key], [field]: value } as never);
      strictNetwork(() => {
        throw new Error('unexpected network');
      });
      const error = failure(await run(cap + 1), JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toBe(
        `Input validation error: Invalid arguments for tool ${name}: ${field}: Too big: expected number to be <=${cap}`,
      );
      expect(calls).toHaveLength(0);

      strictNetwork((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
      const pending = run(cap);
      if (key === 'getStatus') await vi.advanceTimersByTimeAsync(9000);
      const data = parity(await pending);
      expect(data.applied).toMatchObject({ [field]: cap });
      expect(data.notice ?? '').not.toMatch(/exceeds the cap/);
      const forwarded = {
        limit: ['limit', String(cap)],
        maxPoints: ['maxPoints', String(cap)],
        lookbackHours: ['from', String(now / 1000 - cap * 3600)],
        extendWindowSeconds: ['extendWindow', String(cap)],
      } as const;
      const [param, value] = forwarded[field];
      expect(calls.length).toBeGreaterThan(0);
      for (const url of calls) expect(url.searchParams.get(param)).toBe(value);
    },
  );
});

describe('event extension defaults by scope', () => {
  const unscopedDefault =
    'extendWindowSeconds defaulted to 86400 (one day) for global scope, so events that began more than a day before from can be missing. Add entityType for the 14-day default, or pass extendWindowSeconds explicitly; large global extensions can time out.';
  const zeroHit =
    'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.';
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
  it.each(['ucsd-nt', ' ', 'gtr-norm', ' GTR-SARIMA '])(
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
        'Call ioda_get_signals with source bgp, ping-slash24, merit-nt, or gtr; case and surrounding whitespace are accepted.',
      );
      expect(error.data?.recovery?.hint).not.toMatch(/ioda_find_outages|ioda_get_alerts/);
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
        maxPoints: 10000,
      }),
    );
    expect(data.applied).toMatchObject({ maxPoints: 10000, from: window.until - 31 * 86400 });
    expect(data.notice).not.toMatch(/exceeds the cap/);
    expect(calls[0]?.searchParams.get('maxPoints')).toBe('10000');
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
  const larger =
    'Call ioda_get_signals with a larger maxPoints (up to 10000) or a narrower window; the source bucket intervals were inconsistent.';
  /** The one-hour window holds 12 native 300-second buckets; from 12 points up it is served native. */
  it.each([
    [1, larger],
    [11, larger],
    [12, narrower],
    [1999, narrower],
    [10000, narrower],
    [20000, narrower],
  ])(
    'names maxPoints for inconsistent buckets only while the request aggregates the window: %i',
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
  it('requests every status signal at maxPoints 2000, independent of the ioda_get_signals cap', async () => {
    network((url) => envelope(url.pathname.includes('/signals/') ? [[]] : []));
    const pending = runToolContract(getStatus, { ...entityInput, lookbackHours: 24 });
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    const signals = calls.filter((url) => url.pathname.startsWith('/v2/signals/raw/'));
    expect(signals.map((url) => url.searchParams.get('datasource'))).toEqual([
      'bgp',
      'ping-slash24',
      'merit-nt',
    ]);
    expect(signals.map((url) => url.searchParams.get('maxPoints'))).toEqual([
      '2000',
      '2000',
      '2000',
    ]);
    expect(data.applied).toMatchObject({ signals: { maxPoints: 2000 } });
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
  it.each(Object.entries(signalUnits))(
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

describe('gtr signals', () => {
  /** /signals/raw/country/IR?datasource=gtr from 2019-11-14, its first six native buckets. */
  const iran = {
    entityType: 'country',
    entityCode: 'IR',
    entityName: 'Iran (Islamic Republic Of)',
    entityFqid: 'geo.provider.AS.IR',
    datasource: 'gtr',
    subtype: 'WEB_SEARCH',
    from: 1573689600,
    until: 1573700400,
    step: 1800,
    nativeStep: 1800,
    values: [1174307499, 898774895, 683700729, 566366812, 537621458, 611968020],
  };
  const semantics = {
    source: 'gtr',
    measurement: 'Google product traffic from the Google Transparency Report',
    unit: 'Traffic',
    caveat:
      "Compare a country with its own history, not with other countries. A gtr alert's value is the bucket starting at its time divided by 1,000,000 and truncated; its historyValue is a forecast baseline on that scale that this series does not carry.",
  };
  const countriesOnly =
    'IODA serves gtr for countries only. Call ioda_get_signals with source bgp, ping-slash24, or merit-nt for this entity, or with entityType country and a country code for gtr.';
  it('serves a normalized gtr source for a country with Traffic semantics on both surfaces', async () => {
    network(() => envelope([[iran]]));
    const input = { entityType: 'country', entityCode: ' ir ', source: ' GTR ' };
    const result = await runToolContract(getSignals, {
      ...input,
      from: iran.from,
      until: iran.until,
    });
    const data = parity(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/v2/signals/raw/country/IR');
    expect(calls[0]?.searchParams.get('datasource')).toBe('gtr');
    expect(data.series).toEqual([iran]);
    expect(data.semantics).toStrictEqual(semantics);
    expect(data.applied).toEqual({
      entityType: 'country',
      entityCode: 'IR',
      source: 'gtr',
      from: iran.from,
      until: iran.until,
      maxPoints: 200,
    });
    expect(data.notice).toBeUndefined();
    expect(text(result)).toContain('"unit": "Traffic"');
  });
  it('qualifies a coarse gtr series with the shared coarse notice alone', async () => {
    /** The same capture's 12-day window at maxPoints 20: daily means over 1800-second buckets. */
    const daily = {
      ...iran,
      until: 1574726400,
      step: 86400,
      values: [
        3204871923.1666665, 3271094401.7916665, 2095641050.6458333, 52895755.479166664,
        27838870.958333332, 23940705.166666668, 24462729.729166668, 71280401.35416667,
        130473616.95833333, 1019915377.8125, 1713237319.2083333, 1677985208.3125,
      ],
    };
    network(() => envelope([[daily]]));
    const data = parity(
      await runToolContract(getSignals, {
        entityType: 'country',
        entityCode: 'IR',
        source: 'gtr',
        from: daily.from,
        until: daily.until,
        maxPoints: 20,
      }),
    );
    expect(data.series).toEqual([daily]);
    expect(data.notice).toBe(
      'Coarse series aggregate underlying samples, so values need not equal an unweighted mean of finer returned buckets; a non-null aggregate cannot establish complete finer-resolution coverage. Request a narrower window with ioda_get_signals to inspect finer observations.',
    );
  });
  it.each([
    ['region', '1829'],
    ['asn', '44244'],
    ['geoasn', '60627-IR'],
  ])(
    'answers gtr for a %s with the countries-only notice and no verify-code advice',
    async (entityType, entityCode) => {
      network(() => envelope([[]]));
      const data = parity(
        await runToolContract(getSignals, { ...window, entityType, entityCode, source: 'gtr' }),
      );
      expect(data.series).toEqual([]);
      expect(data.notice).toBe(countriesOnly);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.pathname).toBe(`/v2/signals/raw/${entityType}/${entityCode}`);
      expect(calls[0]?.searchParams.get('datasource')).toBe('gtr');
    },
  );
  it('fails an unknown country on gtr as entity_not_found, as for the core sources', async () => {
    network(() =>
      Response.json(
        { error: 'cannot find corresponding metadata entity 0', data: null },
        { status: 400 },
      ),
    );
    const result = await runToolContract(getSignals, {
      ...window,
      entityType: 'country',
      entityCode: 'ZZ',
      source: 'gtr',
    });
    failure(result, JsonRpcErrorCode.NotFound, 'entity_not_found');
    expect(calls).toHaveLength(1);
  });
  it('advertises gtr on ioda_get_signals while ioda_get_status keeps the three core sources', () => {
    type Fields = Record<string, { enum?: string[]; description?: string }>;
    const signals = z.toJSONSchema(getSignals.output).properties as Record<
      string,
      { properties: Fields }
    >;
    expect(signals.semantics?.properties.source?.enum).toEqual(Object.keys(signalUnits));
    expect(signals.semantics?.properties.unit?.enum).toEqual(Object.values(signalUnits));
    const status = z.toJSONSchema(getStatus.output).properties as Record<
      string,
      { items: { properties: Fields } }
    >;
    expect(status.signals?.items.properties.source?.enum).toEqual(Object.keys(units));
    expect(status.signals?.items.properties.unit?.enum).toEqual(Object.values(units));
    const input = z.toJSONSchema(getSignals.input).properties as Fields;
    expect(input.source?.description).toBe(
      'Exactly bgp, ping-slash24, merit-nt, or gtr; case and whitespace normalized. gtr (Google Transparency Report traffic) covers countries only; ucsd-nt is not supported.',
    );
  });
});

describe('empty signal series', () => {
  const missingData = 'Missing data does not establish healthy connectivity.';
  const placeholder =
    'A returned ioda_search_entities row does not confirm IODA holds data for an ASN: IODA answers an ASN it has no record of with a placeholder row whose attrs.ip_count is "0".';
  const generic = `No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source or an earlier window. ${missingData}`;
  /** Each core source's first served UTC day, measured 2026-11-01. */
  const starts = [
    ['merit-nt', 1641686400, '2022-01-09'],
    ['bgp', 1642464000, '2022-01-18'],
    ['ping-slash24', 1643760000, '2022-02-02'],
  ] as const;
  const endsByStart = (source: string, day: string) =>
    `IODA's API holds no ${source} observations before ${day} UTC, and this window ends by then, so an earlier window or another entity code returns none either. ${missingData}`;
  const fromStart = (source: string, day: string) =>
    `IODA's API holds no ${source} observations before ${day} UTC, so only the part of this window from then on can return any.`;
  const empty = async (input: Record<string, unknown>) => {
    network(() => envelope([[]]));
    const data = parity(await runToolContract(getSignals, input as never));
    expect(data.series).toEqual([]);
    expect(calls).toHaveLength(1);
    return data.notice;
  };
  const us = { entityType: 'country', entityCode: 'US' };
  it.each(starts)(
    'states the %s archive start alone for a window ending at it',
    async (source, start, day) => {
      const notice = await empty({ ...us, source, from: start - 86400, until: start });
      expect(notice).toBe(endsByStart(source, day));
    },
  );
  it("answers Iran's November 2019 bgp window with the archive start, not verify-code advice", async () => {
    const notice = await empty({
      entityType: 'country',
      entityCode: 'IR',
      source: 'bgp',
      from: 1573689600,
      until: 1574726400,
    });
    expect(notice).toBe(endsByStart('bgp', '2022-01-18'));
  });
  it.each(starts)(
    'drops the earlier-window advice and adds the %s start for a straddling window',
    async (source, start, day) => {
      const notice = await empty({ ...us, source, from: start - 3600, until: start + 1 });
      expect(notice).toBe(
        `No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source. ${missingData} ${fromStart(source, day)}`,
      );
    },
  );
  it.each(starts)(
    'keeps the generic advice for a %s window from its start',
    async (source, start) => {
      expect(await empty({ ...us, source, from: start, until: start + 3600 })).toBe(generic);
    },
  );
  describe('a window inside the publication allowance', () => {
    const asOf = now / 1000;
    const lag = (allowance: number, source: string) =>
      `No observations were returned. This window starts at most ${allowance} seconds before the call, inside the publication allowance, so IODA may not have published any of its ${source} buckets yet. Call ioda_get_signals with a window ending at least ${allowance} seconds before the call. ${missingData}`;
    it.each([
      ['merit-nt', 7200, 10800],
      ['merit-nt', 10800, 10800],
      ['bgp', 1800, 1800],
      ['ping-slash24', 600, 1800],
      ['gtr', 10800, 10800],
    ] as const)(
      'explains an empty %s window starting %i s before the call by publication lag',
      async (source, start, allowance) => {
        expect(await empty({ ...us, source, from: asOf - start, until: asOf })).toBe(
          lag(allowance, source),
        );
      },
    );
    it.each([
      ['bgp', 1801],
      ['merit-nt', 10801],
    ] as const)(
      'keeps the generic advice for an empty %s window starting %i s before the call',
      async (source, start) => {
        expect(await empty({ ...us, source, from: asOf - start, until: asOf })).toBe(generic);
      },
    );
    it('names publication lag ahead of the ASN placeholder sign', async () => {
      const asn = { entityType: 'asn', entityCode: '4199999999', source: 'bgp' };
      expect(await empty({ ...asn, from: asOf - 600, until: asOf })).toBe(lag(1800, 'bgp'));
    });
    it('keeps the countries-only notice for gtr outside countries', async () => {
      const region = { entityType: 'region', entityCode: '1829', source: 'gtr' };
      expect(await empty({ ...region, from: asOf - 600, until: asOf })).toBe(
        'IODA serves gtr for countries only. Call ioda_get_signals with source bgp, ping-slash24, or merit-nt for this entity, or with entityType country and a country code for gtr.',
      );
    });
  });
  it('gives gtr no archive start and routes a country to a core source', async () => {
    const notice = await empty({
      entityType: 'country',
      entityCode: 'US',
      source: 'gtr',
      from: 1590969600,
      until: 1591574400,
    });
    expect(notice).toBe(
      `No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with a core source or an earlier window. ${missingData}`,
    );
  });
  it('keeps the maxPoints clamp first ahead of the archive notice', async () => {
    const notice = await empty({
      entityType: 'country',
      entityCode: 'US',
      source: 'bgp',
      from: 1642464000 - 86400,
      until: 1642464000,
      maxPoints: 10001,
    });
    expect(notice).toBe(
      `maxPoints 10001 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation. ${endsByStart('bgp', '2022-01-18')}`,
    );
  });
  it('adds nothing to a returned series with leading pre-start nulls', async () => {
    /** bgp for country IR straddling its start: nulls before 2022-01-18 02:15 UTC, then values. */
    const series = {
      entityType: 'country',
      entityCode: 'IR',
      datasource: 'bgp',
      from: 1642471500,
      until: 1642473000,
      step: 300,
      nativeStep: 300,
      values: [null, null, 41672, 41675, 41668],
    };
    network(() => envelope([[series]]));
    const data = parity(
      await runToolContract(getSignals, {
        entityType: 'country',
        entityCode: 'IR',
        source: 'bgp',
        from: series.from,
        until: series.until,
      }),
    );
    expect(data.series).toEqual([series]);
    expect(data.notice).toBeUndefined();
  });
  it('adds nothing to a returned series whose window straddles the bgp start', async () => {
    /** Constructed: two leading nulls from 2022-01-17 23:55 UTC, across the 2022-01-18 constant. */
    const series = {
      entityType: 'country',
      entityCode: 'IR',
      datasource: 'bgp',
      from: 1642463700,
      until: 1642464900,
      step: 300,
      nativeStep: 300,
      values: [null, null, 41672, 41675],
    };
    network(() => envelope([[series]]));
    const data = parity(
      await runToolContract(getSignals, {
        entityType: 'country',
        entityCode: 'IR',
        source: 'bgp',
        from: series.from,
        until: series.until,
      }),
    );
    expect(data.series).toEqual([series]);
    expect(data.notice).toBeUndefined();
  });
  it('names the ASN placeholder sign instead of offering ioda_search_entities as verification', async () => {
    const notice = await empty({
      ...window,
      entityType: 'asn',
      entityCode: '4199999999',
      source: 'bgp',
    });
    expect(notice).toBe(
      `No observations were returned. ${placeholder} Call ioda_get_signals with another core source or an earlier window. ${missingData}`,
    );
    expect(notice).not.toMatch(/verify/);
  });
  it('drops the earlier-window advice for an ASN window straddling the start', async () => {
    const notice = await empty({
      entityType: 'asn',
      entityCode: 'AS4199999999',
      source: 'merit-nt',
      from: 1641686400 - 3600,
      until: 1641686400 + 3600,
    });
    expect(notice).toBe(
      `No observations were returned. ${placeholder} Call ioda_get_signals with another core source. ${missingData} ${fromStart('merit-nt', '2022-01-09')}`,
    );
  });
  it('lets the archive start win over the ASN notice for a window before it', async () => {
    const notice = await empty({
      entityType: 'asn',
      entityCode: '4199999999',
      source: 'ping-slash24',
      from: 1643760000 - 86400,
      until: 1643760000 - 1,
    });
    expect(notice).toBe(endsByStart('ping-slash24', '2022-02-02'));
  });
  it.each([
    ['country', 'US'],
    ['region', '1829'],
    ['geoasn', '60627-IR'],
  ])('keeps the generic advice for an empty %s series', async (entityType, entityCode) => {
    expect(await empty({ ...window, entityType, entityCode, source: 'bgp' })).toBe(generic);
  });
  it('keeps the maxPoints clamp first ahead of the ASN notice', async () => {
    const notice = await empty({
      ...window,
      entityType: 'asn',
      entityCode: '4199999999',
      source: 'bgp',
      maxPoints: 10001,
    });
    expect(notice).toBe(
      `maxPoints 10001 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation. No observations were returned. ${placeholder} Call ioda_get_signals with another core source or an earlier window. ${missingData}`,
    );
  });
});

describe('status ASN placeholder notice', () => {
  const placeholder =
    'No event, alert, or series was returned. A returned ioda_search_entities row does not confirm IODA holds data for an ASN: IODA answers an ASN it has no record of with a placeholder row whose attrs.ip_count is "0".';
  const asOf = now / 1000;
  /** bgp for asn/403156, read live 2026-11-01: an ASN with a placeholder row and all-zero buckets. */
  const zeros = {
    entityType: 'asn',
    entityCode: '403156',
    entityName: 'AS403156',
    entityFqid: 'asn.403156',
    datasource: 'bgp',
    subtype: '',
    from: asOf - 3600,
    until: asOf,
    step: 300,
    nativeStep: 300,
    values: Array<number>(12).fill(0),
  };
  const critical = { ...alert, level: 'critical' };
  type Rows = readonly unknown[];
  /** Status with every component empty except the ones a route answers. */
  const status = async (
    input: Record<string, unknown>,
    routes: { events?: Rows; alerts?: Rows; bgp?: Rows; failed?: string } = {},
  ) => {
    network((url) => {
      const source = url.searchParams.get('datasource');
      if (source && source === routes.failed) return new Response('', { status: 422 });
      if (url.pathname.startsWith('/v2/signals/raw/'))
        return envelope([source === 'bgp' ? (routes.bgp ?? []) : []]);
      return envelope(
        url.pathname.endsWith('/events') ? (routes.events ?? []) : (routes.alerts ?? []),
      );
    });
    const pending = runToolContract(getStatus, input as never);
    await vi.advanceTimersByTimeAsync(9000);
    const data = parity(await pending);
    expect(calls).toHaveLength(5);
    return data;
  };
  it('names the placeholder sign for an ASN with no event, alert, or series, with no extra request', async () => {
    const data = await status({ entityType: 'asn', entityCode: '4199999999' });
    expect(data.detection).toBe('none_returned');
    expect(data.notice).toBe(placeholder);
  });
  it.each([
    ['a series of zeros', { bgp: [zeros] }],
    ['an event', { events: [event] }],
    ['an alert', { alerts: [critical] }],
  ] as const)('omits it for an ASN that returns %s', async (_, routes) => {
    const data = await status({ entityType: 'asn', entityCode: '403156' }, routes);
    expect(data.notice).toBeUndefined();
  });
  it.each([
    ['country', 'US'],
    ['region', '1829'],
    ['geoasn', '60627-IR'],
  ])('omits it for an empty %s', async (entityType, entityCode) => {
    expect((await status({ entityType, entityCode })).notice).toBeUndefined();
  });
  it('follows the lookback clamp and the incomplete-evidence notice', async () => {
    const data = await status(
      { entityType: 'asn', entityCode: '4199999999', lookbackHours: 25 },
      { failed: 'merit-nt' },
    );
    expect(data.notice).toBe(
      `lookbackHours 25 exceeds the cap of 24; served 24. For the uncovered earlier window, call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from ${asOf - 90000} and until ${asOf - 86400}. Evidence is incomplete. Follow each failed component recovery with its standalone tool; missing evidence does not establish healthy connectivity. ${placeholder}`,
    );
  });
});

describe('trailing null buckets', () => {
  const asOf = now / 1000;
  const coarse =
    'Coarse series aggregate underlying samples, so values need not equal an unweighted mean of finer returned buckets; a non-null aggregate cannot establish complete finer-resolution coverage. Request a narrower window with ioda_get_signals to inspect finer observations.';
  const unpublished = (allowance: number) =>
    `Not yet ended and pending buckets (ended within the ${allowance}-second publication allowance before the call) are usually unpublished rather than missing observations.`;
  const advice = (allowance: number, step = 300) =>
    `To read published buckets, end the window at least ${allowance + step} seconds before the call (the allowance plus one ${step}-second bucket, because the last returned bucket can end after until).`;
  const counted = (allowance: number, ...series: string[]) =>
    `Trailing nulls after the last observation: ${series.join('; ')}. ${unpublished(allowance)}`;
  const partial =
    'The last non-null value of series[0] is a coarse bucket that has not ended or ended within the 1800-second allowance, so it can aggregate only the samples published so far.';
  /** One country/US series whose last bucket ends `lastEnd` seconds after the invocation time. */
  const ending = (
    values: (number | null)[],
    lastEnd: number,
    { step = 300, nativeStep = step, datasource = 'bgp', subtype }: Record<string, unknown> = {},
  ) => ({
    entityType: 'country',
    entityCode: 'US',
    datasource,
    ...(subtype !== undefined && { subtype }),
    from: asOf + lastEnd - values.length * (step as number),
    until: asOf + lastEnd,
    step,
    nativeStep,
    values,
  });
  const notice = async (series: object[], input: Record<string, unknown> = {}) => {
    network(() => envelope([series]));
    const data = parity(
      await runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp', ...input }),
    );
    expect(data.series).toEqual(series);
    expect(calls).toHaveLength(1);
    return data.notice;
  };
  it('counts each class of a live merit-nt tail read at the call', async () => {
    /**
     * /signals/raw/country/IR?datasource=merit-nt over three hours, read live 2026-11-01 05:14:28
     * UTC; the last seven of its 37 buckets, starting 1793508000.
     */
    const merit = {
      entityType: 'country',
      entityCode: 'IR',
      entityName: 'Iran (Islamic Republic Of)',
      entityFqid: 'geo.provider.AS.IR',
      datasource: 'merit-nt',
      subtype: '',
      from: 1793508000,
      until: 1793510100,
      step: 300,
      nativeStep: 300,
      values: [74.6, 84.4, 80.2, 74.6, null, null, null],
    };
    vi.setSystemTime(1793510068000);
    const result = await notice([merit], {
      entityType: 'country',
      entityCode: 'IR',
      source: 'merit-nt',
      from: 1793499266,
      until: 1793510066,
    });
    expect(result).toBe(
      `${counted(10800, 'series[0] has 1 not yet ended, 2 pending, and 0 missing')} ${advice(10800)}`,
    );
  });
  it('classifies a live gtr tail against its own 10800-second allowance', async () => {
    /** /signals/raw/country/IR?datasource=gtr, read live 2026-11-01 05:14:36 UTC. */
    const gtr = {
      entityType: 'country',
      entityCode: 'IR',
      entityName: 'Iran (Islamic Republic Of)',
      entityFqid: 'geo.provider.AS.IR',
      datasource: 'gtr',
      subtype: 'WEB_SEARCH',
      from: 1793498400,
      until: 1793511000,
      step: 1800,
      nativeStep: 1800,
      values: [238911239, 275725229, 358255906, 470225260, null, null, null],
    };
    vi.setSystemTime(1793510076000);
    const result = await notice([gtr], {
      entityType: 'country',
      entityCode: 'IR',
      source: 'gtr',
      from: 1793499266,
      until: 1793510066,
    });
    expect(result).toBe(
      `${counted(10800, 'series[0] (subtype WEB_SEARCH) has 1 not yet ended, 2 pending, and 0 missing')} ${advice(10800, 1800)}`,
    );
  });
  it.each([
    ['a bucket ending after the call', [1, null], 100, '1 not yet ended, 0 pending'],
    ['a bucket ending at the call', [1, null], 0, '0 not yet ended, 1 pending'],
    ['a bucket ending 1800 s before the call', [1, null], -1800, '0 not yet ended, 1 pending'],
    ['a tail after an interior null', [1, null, 2, null], 0, '0 not yet ended, 1 pending'],
    ['an all-null tail', [null, null, null], 300, '1 not yet ended, 2 pending'],
  ] as const)('classifies %s', async (_, values, lastEnd, counts) => {
    expect(await notice([ending([...values], lastEnd)])).toBe(
      `${counted(1800, `series[0] has ${counts}, and 0 missing`)} ${advice(1800)}`,
    );
  });
  it('splits a tail at the allowance and counts the overdue buckets as missing', async () => {
    expect(await notice([ending([1, null, null, null], -1500)])).toBe(
      `${counted(1800, 'series[0] has 0 not yet ended, 2 pending, and 1 missing')} ${advice(1800)}`,
    );
  });
  it.each([
    ['a tail ending 1801 s before the call', [1, null], -1801, {}],
    ['a native series ending non-null', [1, null, 2], 0, {}],
    ['a gtr tail ending 10801 s before', [1, null], -10801, { step: 1800, datasource: 'gtr' }],
    ['a merit-nt tail ending 10801 s before', [1, null], -10801, { datasource: 'merit-nt' }],
  ] as const)('adds nothing for %s', async (_, values, lastEnd, options) => {
    const source = 'datasource' in options ? options.datasource : 'bgp';
    expect(await notice([ending([...values], lastEnd, options)], { source })).toBeUndefined();
  });
  it('keeps a gtr tail ending 10800 s before the call pending', async () => {
    const series = ending([1, null], -10800, { step: 1800, datasource: 'gtr' });
    expect(await notice([series], { source: 'gtr' })).toBe(
      `${counted(10800, 'series[0] has 0 not yet ended, 1 pending, and 0 missing')} ${advice(10800, 1800)}`,
    );
  });
  it('keeps a merit-nt tail ending 10800 s before the call pending, since merit-nt publishes in batches', async () => {
    const series = ending([1, null], -10800, { datasource: 'merit-nt' });
    expect(await notice([series], { source: 'merit-nt' })).toBe(
      `${counted(10800, 'series[0] has 0 not yet ended, 1 pending, and 0 missing')} ${advice(10800)}`,
    );
  });
  it('lists every subtype with a tail once one is unpublished, and skips one ending non-null', async () => {
    const series = [
      ending([1, null], 0, { subtype: 'a' }),
      ending([1, null, null], -3600, { subtype: 'b' }),
      ending([1, 2], 0, { subtype: 'c' }),
    ];
    expect(await notice(series)).toBe(
      `${counted(1800, 'series[0] (subtype a) has 0 not yet ended, 1 pending, and 0 missing', 'series[1] (subtype b) has 0 not yet ended, 0 pending, and 2 missing')} ${advice(1800)}`,
    );
  });
  it('names a live coarse last bucket that is still open as possibly partial', async () => {
    /** bgp for country/IR at maxPoints 6 over one day, read live 2026-11-01 05:27:50 UTC. */
    const daily = {
      entityType: 'country',
      entityCode: 'IR',
      entityName: 'Iran (Islamic Republic Of)',
      entityFqid: 'geo.provider.AS.IR',
      datasource: 'bgp',
      subtype: '',
      from: 1793404800,
      until: 1793512800,
      step: 21600,
      nativeStep: 300,
      values: [
        41672.333333333336, 41674.72222222222, 41668.333333333336, 41661.305555555555,
        41647.82258064516,
      ],
    };
    vi.setSystemTime(1793510870000);
    const result = await notice([daily], {
      entityType: 'country',
      entityCode: 'IR',
      from: 1793424469,
      until: 1793510869,
      maxPoints: 6,
    });
    expect(result).toBe(`${coarse} ${partial} ${advice(1800, 21600)}`);
  });
  it.each([
    [-1800, true],
    [-1801, false],
  ])(
    'treats a coarse last bucket ending %i s from the call as partial: %s',
    async (lastEnd, open) => {
      const series = ending([5, 6], lastEnd, { step: 1800, nativeStep: 300 });
      expect(await notice([series])).toBe(
        open ? `${coarse} ${partial} ${advice(1800, 1800)}` : coarse,
      );
    },
  );
  it('names a coarse gtr last bucket within its 10800-second allowance as possibly partial', async () => {
    const series = ending([5, 6], -5000, { step: 3600, nativeStep: 1800, datasource: 'gtr' });
    expect(await notice([series], { source: 'gtr' })).toBe(
      `${coarse} The last non-null value of series[0] is a coarse bucket that has not ended or ended within the 10800-second allowance, so it can aggregate only the samples published so far. ${advice(10800, 3600)}`,
    );
  });
  it('counts a coarse tail and names the last non-null coarse bucket before it', async () => {
    const series = ending([5, null], 600, { step: 1800, nativeStep: 300 });
    expect(await notice([series])).toBe(
      `${coarse} ${counted(1800, 'series[0] has 1 not yet ended, 0 pending, and 0 missing')} ${partial} ${advice(1800, 1800)}`,
    );
  });
  it('counts a bucket aligned past an until 1800 s before the call as pending', async () => {
    /** The returned bounds extend past until: the last bucket ends 1559 s before the call. */
    expect(await notice([ending([1, null], -1559)], { until: asOf - 1800 })).toBe(
      `${counted(1800, 'series[0] has 0 not yet ended, 1 pending, and 0 missing')} ${advice(1800)}`,
    );
  });
  it('adds nothing once the window ends the advised allowance plus one step before the call', async () => {
    expect(await notice([ending([1, null], -2100)], { until: asOf - 2100 })).toBeUndefined();
  });
  it('adds no output field: the notice alone carries the classification', () => {
    expect(Object.keys(getSignals.output.shape)).toEqual(['series', 'semantics', 'provenance']);
  });
  it('advertises both allowances where the description explains nulls', () => {
    expect(getSignals.description).toContain(
      'trailing nulls in buckets not yet ended or ended within the publication allowance before the call (1800 seconds for bgp and ping-slash24, 10800 for merit-nt and gtr) are usually unpublished, and every other null is a missing observation',
    );
  });
  it('keeps the maxPoints clamp first ahead of the trailing-null notice', async () => {
    expect(await notice([ending([1, null], 0)], { maxPoints: 10001 })).toBe(
      `maxPoints 10001 exceeds the cap of 10000; served 10000. Every maxPoints of 10000 or more requests the same aggregation. ${counted(1800, 'series[0] has 0 not yet ended, 1 pending, and 0 missing')} ${advice(1800)}`,
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

describe('literal query substrings', () => {
  /** Captured /entities/query country rows and asn rows for search=Telegram\_Messenger. */
  const corpus: Record<string, { name: string; [field: string]: unknown }[]> = {
    country: [
      ['AS', 'American Samoa', 'OC'],
      ['AZ', 'Azerbaijan', 'AS'],
      ['DE', 'Germany', 'EU'],
      ['IR', 'Iran (Islamic Republic Of)', 'AS'],
      ['US', 'United States', 'NA'],
    ].map(([code = '', name = '', continent = '']) => ({
      code,
      name,
      type: 'country',
      subnames: [],
      attrs: { fqid: `geo.netacuity.${continent}.${code}` },
    })),
    asn: [
      {
        code: '44907',
        name: 'AS44907 (Telegram_Messenger_CDN)',
        type: 'asn',
        subnames: [],
        attrs: {
          ip_count: '1024',
          fqid: 'asn.44907',
          name: 'Telegram_Messenger_CDN',
          org: 'Telegram Messenger Inc',
        },
      },
      {
        code: '59930',
        name: 'AS59930 (Telegram_Messenger)',
        type: 'asn',
        subnames: [],
        attrs: {
          fqid: 'asn.59930',
          ip_count: '2048',
          name: 'Telegram_Messenger',
          org: 'Telegram Messenger Inc',
        },
      },
    ],
  };
  /** IODA's `name ILIKE '%' || search || '%'`; PostgreSQL LIKE escapes the next character with a backslash. */
  function ilike(name: string, search: string): boolean {
    let pattern = '';
    for (let index = 0; index < search.length; index++) {
      const char = search[index] ?? '';
      if (char === '%') pattern += '[\\s\\S]*';
      else if (char === '_') pattern += '[\\s\\S]';
      else
        pattern += (char === '\\' ? (search[++index] ?? '') : char).replace(
          /[$()*+.?[\\\]^{|}]/g,
          '\\$&',
        );
    }
    return new RegExp(pattern, 'i').test(name);
  }
  function upstream(url: URL) {
    const search = url.searchParams.get('search');
    const rows = corpus[url.searchParams.get('entityType') ?? ''] ?? [];
    return envelope(search === null ? rows : rows.filter((row) => ilike(row.name, search)));
  }
  const zeroHit =
    'No matching entities. Call ioda_search_entities with a shorter query or omit query to list this entity type.';

  it('describes query as a literal case-insensitive substring', () => {
    expect(searchEntities.input.shape.query.description).toMatch(
      /^Case-insensitive name substring, matched literally \(% and _ are not wildcards\);/,
    );
  });
  it.each([
    ['%', '\\%'],
    ['_', '\\_'],
    ['i_an', 'i\\_an'],
    ['ir\\an', 'ir\\\\an'],
  ])('matches country query %j literally: sends %j and returns no rows', async (query, search) => {
    network(upstream);
    const data = parity(await runToolContract(searchEntities, { entityType: 'country', query }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('search')).toBe(search);
    expect(data.entities).toEqual([]);
    expect(data.notice).toBe(zeroHit);
    expect(data.applied).toEqual({ entityType: 'country', query, limit: 20, page: 0 });
  });
  it.each([
    ['asn', ' Telegram_Messenger ', 'Telegram\\_Messenger', ['44907', '59930']],
    ['country', 'iran', 'iran', ['IR']],
  ])(
    'matches %s query %j as the literal substring %j',
    async (entityType, query, search, codes) => {
      network(upstream);
      const data = parity(await runToolContract(searchEntities, { entityType, query }));
      expect(calls[0]?.searchParams.get('search')).toBe(search);
      expect((data.entities as { code: string }[]).map((row) => row.code)).toEqual(codes);
      expect(data.notice).toBeUndefined();
      expect(data.applied).toEqual({ entityType, query: query.trim(), limit: 20, page: 0 });
    },
  );
});

describe('placeholder regions', () => {
  const iran = ['AS', 'IR', 'Iran (Islamic Republic Of)'] as const;
  const congo = ['AF', 'CD', 'Democratic Republic Of The Congo'] as const;
  function region(
    [continent, country_code, country_name]: readonly [string, string, string],
    code: string,
    name: string,
    neRegionId?: string,
  ) {
    return {
      code,
      name,
      type: 'region',
      subnames: [],
      attrs: {
        fqid: `geo.netacuity.${continent}.${country_code}.${code}`,
        country_code,
        country_name,
        ...(neRegionId && { ne_region_id: neRegionId }),
      },
    };
  }
  /** Captured /entities/query?entityType=region&relatedTo=country/IR rows: 4 of 33, in IODA's order. */
  const iranRegions = [
    region(iran, '1821', '[Invalid Region (1821)]'),
    region(iran, '1823', 'Bushehr', '3210'),
    region(iran, '1829', 'Tehran', '3216'),
    region(iran, '4800', 'Unknown Region in Iran (Islamic Republic Of)'),
  ];
  const sudKivu = region(congo, '694', 'Sud-Kivu', '1894');
  const congoUnknown = region(congo, '4680', 'Unknown Region in Democratic Republic Of The Congo');
  const congoEvent = (entity: typeof sudKivu, from: number, until: number, score: number) => ({
    entity,
    from,
    until,
    score,
    datasource: 'bgp',
    method: 'median',
  });
  /** Captured /outages/events?entityType=region&relatedTo=country/CD rows, the first four. */
  const congoEvents = [
    congoEvent(sudKivu, 1792920600, 1792921500, 53.57142857142857),
    congoEvent(congoUnknown, 1792930500, 1792931400, 26.94610778443114),
    congoEvent(sudKivu, 1792940100, 1792992900, 3142.8571428571427),
    congoEvent(congoUnknown, 1792949400, 1792954500, 101.79640718562875),
  ];
  const congoAlert = (
    entity: typeof sudKivu,
    time: number,
    level: string,
    condition: string,
    value: number,
    historyValue: number,
  ) => ({
    datasource: 'bgp',
    entity,
    time,
    level,
    condition,
    value,
    historyValue,
    method: 'median',
  });
  /** Captured /outages/alerts?entityType=region&relatedTo=country/CD rows, the first four. */
  const congoAlerts = [
    congoAlert(sudKivu, 1792920600, 'critical', '< 0.99', 27, 28),
    congoAlert(sudKivu, 1792921500, 'normal', 'normal', 28, 28),
    congoAlert(congoUnknown, 1792930500, 'critical', '< 0.99', 164, 167),
    congoAlert(congoUnknown, 1792931400, 'normal', 'normal', 167, 167),
  ];
  /** Captured /outages/summary?entityType=region&relatedTo=country/CD rows: the whole page. */
  const congoSummaries = [
    {
      entity: sudKivu,
      scores: { overall: 24926.071428571428, 'bgp.median': 24926.071428571428 },
      event_cnt: 9,
    },
    {
      entity: congoUnknown,
      scores: { overall: 3062.0359281437127, 'bgp.median': 3062.0359281437127 },
      event_cnt: 15,
    },
  ];
  const iranCatchAlls =
    'Regions 1821, 4800 are IODA geolocation catch-alls rather than provinces or states; do not report them as such.';
  const congoCatchAll =
    'Region 4680 is an IODA geolocation catch-all rather than a province or state; do not report it as one.';

  it.each([
    ['[Invalid Region (1821)]', 'region', true],
    ['Unknown Region in Iran (Islamic Republic Of)', 'region', true],
    ['Unknown Region in Unknown Country', 'region', true],
    ['Tehran', 'region', false],
    ['Vientiane [prefecture]', 'region', false],
    ['[Invalid Region (1821)] ', 'region', false],
    ['[Invalid Region (1821)]\n', 'region', false],
    ['[Invalid Region ()]', 'region', false],
    ['[Invalid Region (18a)]', 'region', false],
    ['x [Invalid Region (1821)]', 'region', false],
    ['unknown region in Iran (Islamic Republic Of)', 'region', false],
    ['Unknown Region', 'region', false],
    ['Unknown Region in Iran (Islamic Republic Of)', 'country', false],
    ['[Invalid Region (1821)]', 'geoasn', false],
    ['Unknown Region in Iran (Islamic Republic Of)', null, false],
  ] as const)('classifies name %j on a %s row as a placeholder: %s', (name, type, placeholder) => {
    expect(isPlaceholderRegion({ code: '1821', name, type })).toBe(placeholder);
  });
  it('says in the resolver and ranking descriptions that region results can include them', () => {
    for (const definition of [searchEntities, summarizeOutages])
      expect(definition.description).toMatch(
        /can include IODA geolocation catch-alls named \[Invalid Region \(N\)\] or Unknown Region in <country>, which are not provinces or states; a notice names them\./,
      );
  });
  it('names each placeholder code once in page order, and nothing for a page without one', () => {
    expect(placeholderRegionNotice([sudKivu, congoUnknown, sudKivu, congoUnknown])).toBe(
      congoCatchAll,
    );
    expect(placeholderRegionNotice([...iranRegions].reverse())).toBe(
      'Regions 4800, 1821 are IODA geolocation catch-alls rather than provinces or states; do not report them as such.',
    );
    expect(placeholderRegionNotice([sudKivu, ...iranRegions.slice(1, 3)])).toBeUndefined();
    expect(placeholderRegionNotice([])).toBeUndefined();
  });
  it("names 1821 and 4800 in Iran's region listing, not Tehran, with the rows unchanged", async () => {
    network(() => envelope(iranRegions));
    const data = parity(
      await runToolContract(searchEntities, {
        entityType: 'region',
        relatedToType: 'country',
        relatedToCode: 'IR',
        limit: 100,
      }),
    );
    expect(data.entities).toEqual(iranRegions);
    expect(data.notice).toBe(iranCatchAlls);
    expect(data.notice).not.toContain('1829');
  });
  it("names 4680 once in DR Congo's region ranking, events, and alerts after the membership notice", async () => {
    const scope = {
      ...window,
      entityType: 'region',
      relatedToType: 'country',
      relatedToCode: 'CD',
    };
    for (const [rows, key, run] of [
      [congoSummaries, 'summaries', () => runToolContract(summarizeOutages, scope)],
      [congoEvents, 'events', () => runToolContract(findOutages, scope)],
      [congoAlerts, 'alerts', () => runToolContract(getAlerts, scope)],
    ] as const) {
      network(() => envelope(rows));
      const data = parity(await run());
      expect(data[key]).toEqual(rows);
      expect(data.notice).toMatch(/^Membership coverage is unverified:/);
      expect(rowGuidance(data.notice)).toBe(congoCatchAll);
    }
    expect(calls).toHaveLength(3);
  });
  it('keeps a limit clamp first and the continuation last around the placeholder notice', async () => {
    network(() => envelope(congoSummaries));
    const data = parity(
      await runToolContract(summarizeOutages, { ...window, entityType: 'region', limit: 2000 }),
    );
    expect(data.notice).toBe(
      `limit 2000 exceeds the cap of 1000; served 1000. Every limit of 1000 or more serves the same pages. ${congoCatchAll}`,
    );
    network(() => envelope(congoEvents));
    const events = parity(
      await runToolContract(findOutages, { ...window, entityType: 'region', limit: 4 }),
    );
    expect(events.notice).toBe(
      `${congoCatchAll} Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.`,
    );
  });
});

describe('placeholder ASN rows', () => {
  /** Captured /entities/query?entityType=asn&entityCode=<code> rows. */
  const asnRow = (code: string, ipCount: string) => ({
    code,
    name: `AS${code}`,
    type: 'asn',
    subnames: [],
    attrs: { fqid: `asn.${code}`, ip_count: ipCount },
  });
  const placeholder = (code: string) =>
    `ASN ${code} came back as IODA's placeholder row (attrs.ip_count "0"), which IODA returns for an ASN it holds no record of, so the row neither confirms the ASN nor shows whether IODA measures it. Call ioda_get_signals with entityType asn, entityCode ${code}, a source, and a window to check for observations.`;

  it.each([
    ['4199999999', asnRow('4199999999', '0'), placeholder('4199999999')],
    ['403156', asnRow('403156', '0'), placeholder('403156')],
    ['64512', asnRow('64512', '1024'), undefined],
  ])('answers an asn entityCode %s lookup by its ip_count', async (code, row, notice) => {
    network(() => envelope([row]));
    const data = parity(
      await runToolContract(searchEntities, { entityType: 'asn', entityCode: `AS${code}` }),
    );
    expect(calls[0]?.searchParams.get('entityCode')).toBe(code);
    expect(data.entities).toEqual([row]);
    expect(data.notice).toBe(notice);
  });
  it('matches ip_count "0" on asn rows only and names each one', async () => {
    const geoasn = {
      code: '40934-576',
      name: 'AS40934 -- British Columbia',
      type: 'geoasn',
      subnames: { asn: 'AS40934', region: 'British Columbia' },
      attrs: { fqid: 'geoasn.40934-576', ip_count: '0' },
    };
    network(() => envelope([geoasn]));
    expect(parity(await runToolContract(searchEntities, { entityType: 'geoasn' })).notice).toBe(
      undefined,
    );
    network(() =>
      envelope([asnRow('4199999999', '0'), asnRow('64512', '1024'), asnRow('3876543210', '0')]),
    );
    expect(parity(await runToolContract(searchEntities, { entityType: 'asn' })).notice).toBe(
      `${placeholder('4199999999')} ${placeholder('3876543210')}`,
    );
  });
});

describe('empty windows against the detection archive start', () => {
  /** 2019-11-14 to 2019-11-26 UTC, Iran's November 2019 shutdown; IODA answers [] for each endpoint. */
  const shutdown = { from: 1573689600, until: 1574726400 };
  /** 2022-01-25 to 2022-01-27 UTC, across the 2022-01-26 detection start. */
  const straddling = { from: 1643068800, until: 1643241600 };
  /** 2022-01-15 to 2022-01-20 UTC: before the start, but within 14 days of it. */
  const nearStart = { from: 1642204800, until: 1642636800 };
  const before =
    "IODA's API holds no outage detections (alerts, events, or summary rows) before 2022-01-26 UTC, and this window ends by then, so an earlier window or another entity code returns none either.";
  const straddles =
    "IODA's API holds no outage detections (alerts, events, or summary rows) before 2022-01-26 UTC, so only the part of this window from then on can return any.";
  const verify =
    'IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.';
  const eventsZeroHit =
    'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.';
  const summaryZeroHit =
    'No outage summaries were returned for this scope and window. Call ioda_find_outages for detected events or ioda_get_signals for measurement coverage, or ioda_summarize_outages with a wider window or fewer filters. This is not an all-clear.';
  const alertsZeroHit =
    'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.';
  const iran = { entityType: 'country', entityCode: 'IR' };
  const irRegions = { entityType: 'region', relatedToType: 'country', relatedToCode: 'IR' };

  it.each([
    [
      'ioda_find_outages for one entity',
      () => runToolContract(findOutages, { ...shutdown, ...iran }),
      `${before} This is not an all-clear.`,
    ],
    [
      'ioda_find_outages in global scope',
      () => runToolContract(findOutages, shutdown),
      `extendWindowSeconds defaulted to 86400 (one day) for global scope, so events that began more than a day before from can be missing. Add entityType for the 14-day default, or pass extendWindowSeconds explicitly; large global extensions can time out. ${before} This is not an all-clear.`,
    ],
    [
      'ioda_summarize_outages for one entity',
      () => runToolContract(summarizeOutages, { ...shutdown, ...iran }),
      before,
    ],
    [
      'ioda_summarize_outages with a clamped limit',
      () => runToolContract(summarizeOutages, { ...shutdown, entityType: 'country', limit: 2000 }),
      `limit 2000 exceeds the cap of 1000; served 1000. Every limit of 1000 or more serves the same pages. ${before}`,
    ],
    [
      'ioda_get_alerts for one entity',
      () => runToolContract(getAlerts, { ...shutdown, ...iran }),
      before,
    ],
    [
      'ioda_get_alerts with an extension that stays before the start',
      () =>
        runToolContract(getAlerts, {
          ...nearStart,
          entityType: 'country',
          extendWindowSeconds: 43200,
        }),
      before,
    ],
    [
      'ioda_get_alerts with a clamped extension, keyed on the served 1209600 rather than the requested 2000000',
      () =>
        runToolContract(getAlerts, {
          from: 1641686400,
          until: 1641772800,
          entityType: 'country',
          extendWindowSeconds: 2000000,
        }),
      `extendWindowSeconds 2000000 exceeds the cap of 1209600; served 1209600. Transitions more than 1209600 seconds before from or after until are not returned. To reach the earlier ones, call ioda_get_alerts at page 0 with from 1640896000, until 1641772800, extendWindowSeconds 1209600, and the other filters unchanged; for the later ones, use from 1641686400 and until 1642563200 instead. ${before}`,
    ],
  ])('answers an empty first page from %s with the archive start alone', async (_, run, notice) => {
    network(() => envelope([]));
    const data = parity(await run());
    expect(data.notice).toBe(notice);
    expect(calls).toHaveLength(1);
  });
  it('keeps the membership notice and drops the verify-scope clause for a scoped window before the start', async () => {
    for (const [run, notice] of [
      [
        () => runToolContract(findOutages, { ...shutdown, ...irRegions }),
        `${before} This is not an all-clear.`,
      ],
      [() => runToolContract(summarizeOutages, { ...shutdown, ...irRegions }), before],
      [() => runToolContract(getAlerts, { ...shutdown, ...irRegions }), before],
    ] as const) {
      network(() => envelope([]));
      const data = parity(await run());
      expect(data.notice).toMatch(/^Membership coverage is unverified:/);
      expect(rowGuidance(data.notice)).toBe(notice);
    }
    expect(calls).toHaveLength(3);
  });
  it.each([
    [
      'ioda_find_outages',
      () => runToolContract(findOutages, { ...straddling, ...iran }),
      `${eventsZeroHit} ${verify} ${straddles}`,
    ],
    [
      'ioda_summarize_outages',
      () => runToolContract(summarizeOutages, { ...straddling, entityType: 'country' }),
      `${summaryZeroHit} ${straddles}`,
    ],
    [
      'ioda_get_alerts',
      () => runToolContract(getAlerts, { ...straddling, ...iran }),
      `${alertsZeroHit} ${verify} ${straddles}`,
    ],
    [
      'ioda_get_alerts whose extension reaches past the start',
      () =>
        runToolContract(getAlerts, {
          ...nearStart,
          entityType: 'country',
          extendWindowSeconds: 1209600,
        }),
      `${alertsZeroHit} ${straddles}`,
    ],
  ])(
    'keeps the usual guidance and adds the archive sentence for %s across the start',
    async (_, run, notice) => {
      network(() => envelope([]));
      expect(parity(await run()).notice).toBe(notice);
    },
  );
  it('keys events and rankings on the window alone, so a 14-day extension does not cross the start', async () => {
    for (const run of [
      () => runToolContract(findOutages, { ...nearStart, entityType: 'country' }),
      () => runToolContract(summarizeOutages, { ...nearStart, entityType: 'country' }),
    ]) {
      network(() => envelope([]));
      const data = parity(await run());
      expect(data.applied).toMatchObject({ extendWindowSeconds: 1209600 });
      expect(String(data.notice).startsWith(before)).toBe(true);
    }
  });
  it('leaves later pages, non-empty pages, and windows from the start on unchanged', async () => {
    for (const [tool, run] of [
      ['ioda_find_outages', () => runToolContract(findOutages, { ...shutdown, ...iran, page: 1 })],
      [
        'ioda_summarize_outages',
        () => runToolContract(summarizeOutages, { ...shutdown, ...iran, page: 1 }),
      ],
      ['ioda_get_alerts', () => runToolContract(getAlerts, { ...shutdown, ...iran, page: 1 })],
    ] as const) {
      network(() => envelope([]));
      expect(parity(await run()).notice).toBe(
        `This page is empty. Call ${tool} with page 0 and unchanged filters, or return to the previous page.`,
      );
    }
    network(() => envelope([event]));
    expect(
      parity(await runToolContract(findOutages, { ...shutdown, ...iran })).notice,
    ).toBeUndefined();
    network(() => envelope([]));
    expect(
      parity(
        await runToolContract(summarizeOutages, {
          from: 1643155200,
          until: 1643241600,
          entityType: 'country',
        }),
      ).notice,
    ).toBe(summaryZeroHit);
  });
  it('states the archive starts in the shared from descriptions', () => {
    for (const definition of [findOutages, summarizeOutages, getAlerts])
      expect(definition.input.shape.from.description).toBe(
        "Inclusive Unix seconds UTC; no milliseconds; window at most 31 days. IODA's API holds no outage detections before 2022-01-26 UTC.",
      );
    expect(getSignals.input.shape.from.description).toBe(
      "Requested start Unix seconds UTC; window at most 31 days. Aligned returned buckets may begin earlier. IODA's API holds no merit-nt observations before 2022-01-09 UTC, no bgp before 2022-01-18, and no ping-slash24 before 2022-02-02.",
    );
  });
});

describe('re-based recovery baselines', () => {
  it("tells alert readers to judge a recovery against the detection's baseline", () => {
    expect(getAlerts.description).toContain(
      "levels and baselines are not a source-independent severity scale. A recovery's historyValue can be a baseline IODA re-based during a long event; compare its value with the detection's historyValue and condition. Transitions include",
    );
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
    expect(data.notice).toBe(
      'Region 1821 is an IODA geolocation catch-all rather than a province or state; do not report it as one.',
    );

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
    expect(data.notice).toBeUndefined();
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
    ]);
    const upstream = entries.filter((entry) => entry.reason.startsWith('upstream_'));
    expect(upstream).toHaveLength(6);
    for (const entry of [
      ...upstream,
      ...entries.filter((entry) => entry.reason === 'entity_not_found'),
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
  it('serves limit 1000 and a 1209600 extension unchanged, and over-cap values at the caps with notices', async () => {
    network(() => envelope([]));
    let data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        limit: 1000,
        extendWindowSeconds: 1209600,
      }),
    );
    expect(query(calls[0])).toMatchObject({ limit: '1000', extendWindow: '1209600' });
    expect(data.notice).toBe(zeroHit);

    network(() => envelope([]));
    data = parity(
      await runToolContract(summarizeOutages, {
        ...window,
        entityType: 'region',
        limit: 1001,
        extendWindowSeconds: 12096000,
        page: 2,
      }),
    );
    expect(query(calls[1])).toMatchObject({ limit: '1000', extendWindow: '1209600', page: '2' });
    expect(data.applied).toMatchObject({ limit: 1000, extendWindowSeconds: 1209600, page: 2 });
    expect(data.notice).toBe(
      `limit 1001 exceeds the cap of 1000; served 1000. Page 2 starts after the first 2000 records. Every limit of 1000 or more serves the same pages. extendWindowSeconds 12096000 exceeds the cap of 1209600; served 1209600. Events overlapping the window that began more than 1209600 seconds before from are not counted, or are counted from a later start. To check one entity for such an event, call ioda_find_outages with this entityType, that entity's code as entityCode, from 1789858801, until 1792537201, and extendWindowSeconds 1209600, then keep only the events whose until is at or after 1792537200. ${pastEnd}`,
    );
  });
  it.each([
    [
      { entityType: 'region', extendWindowSeconds: -1 },
      'extendWindowSeconds: Too small: expected number to be >=0',
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
  it('returns a full ranking page of wide rows whole on both surfaces', async () => {
    const wide = Array.from({ length: 100 }, (_, index) =>
      country(String(index), 'x'.repeat(600), `geo.${index}`, { overall: 100 - index }, 1),
    );
    network(() => envelope(wide));
    const data = parity(
      await runToolContract(summarizeOutages, { ...window, entityType: 'region', limit: 100 }),
    );
    expect(data.summaries).toEqual(wide);
    expect(data.pagination).toMatchObject({ limit: 100, returned: 100, more: 'possible' });
    expect(calls).toHaveLength(1);
  });
});

describe('hostile Markdown fence bounds', () => {
  it('returns a multi-megabyte record with multibyte text and a numeric array whole on both surfaces', async () => {
    const numbers = Array.from({ length: 200 }, (_, index) => (index % 7 ? index : null));
    const name = `雪${'x'.repeat(1_000_000)}雪`;
    network(() => envelope([{ code: 'US', name, x: numbers }]));
    const result = await runToolContract(searchEntities, { entityType: 'country', limit: 1 });
    const data = parity(result);
    expect(data.entities).toEqual([{ code: 'US', name, x: numbers }]);
    expect(text(result)).toContain(`"x": ${JSON.stringify(numbers)}`);
    expect(text(result)).toContain(JSON.stringify(name));
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

describe('archive starts', () => {
  const starts = [
    ['merit-nt', 1641686400, '2022-01-09'],
    ['bgp', 1642464000, '2022-01-18'],
    ['ping-slash24', 1643760000, '2022-02-02'],
    ['detections', 1643155200, '2022-01-26'],
  ] as const;

  it.each(starts)('places a window against the %s start (%i)', (series, start) => {
    expect(archivePosition({ from: start - 86400, until: start - 1 }, series)).toBe('before');
    expect(archivePosition({ from: start - 86400, until: start }, series)).toBe('before');
    expect(archivePosition({ from: start - 86400, until: start + 1 }, series)).toBe('straddles');
    expect(archivePosition({ from: start, until: start + 86400 }, series)).toBe('after');
  });

  it.each(starts)('names the %s start day in both archive sentences', (series, _start, day) => {
    const before = archiveNotice(series, 'before');
    const straddles = archiveNotice(series, 'straddles');
    expect(before).toContain(`before ${day} UTC, and this window ends by then`);
    expect(before).not.toMatch(/ioda_search_entities|wider window/);
    expect(straddles).toContain(`before ${day} UTC, so only the part of this window`);
  });

  it('names detections rather than a source for the alert, event, and summary start', () => {
    expect(archiveNotice('detections', 'before')).toContain(
      'outage detections (alerts, events, or summary rows)',
    );
    expect(archiveNotice('bgp', 'before')).toContain('no bgp observations before');
  });
});
