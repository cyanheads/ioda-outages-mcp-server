/**
 * @fileoverview Public IODA contracts exercised through the injected HTTP boundary.
 * @module tests/tools/contracts
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOutages } from '../../src/mcp-server/tools/definitions/find-outages.tool.js';
import { getAlerts } from '../../src/mcp-server/tools/definitions/get-alerts.tool.js';
import { getSignals } from '../../src/mcp-server/tools/definitions/get-signals.tool.js';
import { getStatus } from '../../src/mcp-server/tools/definitions/get-status.tool.js';
import { searchEntities } from '../../src/mcp-server/tools/definitions/search-entities.tool.js';
import { renderJson } from '../../src/mcp-server/tools/ioda-common.js';
import { disposeIodaService, initIodaService } from '../../src/services/ioda/index.js';

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
      error: { code: number; data?: { reason?: string; recovery?: { hint: string } } };
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
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  calls.length = 0;
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
      expect(data.notice).toMatch(page ? /page 0/ : /shorter query/);
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

describe('errors visible on both consumption paths', () => {
  const invocations = [
    { name: 'events', run: () => runToolContract(findOutages, window) },
    { name: 'alerts', run: () => runToolContract(getAlerts, window) },
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
  it.each(['gtr', 'ucsd-nt', ' '])(
    'rejects unsupported numeric source %j rather than substituting a core measurement',
    async (source) => {
      failure(
        await runToolContract(getSignals, { ...window, ...entityInput, source }),
        JsonRpcErrorCode.InvalidParams,
      );
      expect(calls).toHaveLength(0);
    },
  );
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
    failure(
      await runToolContract(getStatus, { entityType: 'country', entityCode: 'USA' }),
      JsonRpcErrorCode.ValidationError,
      'invalid_entity',
    );
    failure(
      await runToolContract(findOutages, { ...window, entityCode: 'US' }),
      JsonRpcErrorCode.ValidationError,
      'invalid_entity',
    );
    expect(calls).toHaveLength(0);
  });
  it.each([
    { from: window.until, until: window.from },
    { from: window.from, until: window.until + 1 },
    { from: window.until - 31 * 86400 - 1, until: window.until },
    { from: now - 3600000, until: now },
  ])('rejects invalid window %j with a concrete retry', async (input) => {
    failure(
      await runToolContract(getAlerts, input),
      JsonRpcErrorCode.ValidationError,
      'invalid_window',
    );
  });
  it.each([0, 101])('rejects page limit %i at the schema boundary', async (limit) => {
    failure(
      await runToolContract(searchEntities, { entityType: 'country', limit }),
      JsonRpcErrorCode.InvalidParams,
    );
  });
  it.each([0, 2001])('rejects maxPoints %i at the schema boundary', async (maxPoints) => {
    failure(
      await runToolContract(getSignals, { ...window, ...entityInput, source: 'bgp', maxPoints }),
      JsonRpcErrorCode.InvalidParams,
    );
  });
  it.each([0, 25])('rejects lookback %i at the schema boundary', async (lookbackHours) => {
    failure(
      await runToolContract(getStatus, { ...entityInput, lookbackHours }),
      JsonRpcErrorCode.InvalidParams,
    );
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
      ['bgp', 'ping-slash24', 'merit-nt'].map((source) => ({
        source,
        coverage: 'no_data',
        series: [],
      })),
    );
    expect(data.applied).toMatchObject({ lookbackHours: 6, signals: { maxPoints: 2000 } });
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
    expect(data.signals).toEqual(
      expect.arrayContaining([{ source: 'bgp', coverage: 'unknown', series: [] }]),
    );
  });
  it('reports an all-component failure as an error', async () => {
    network(() => new Response('', { status: 400 }));
    const pending = runToolContract(getStatus, entityInput);
    await vi.advanceTimersByTimeAsync(9000);
    failure(await pending, JsonRpcErrorCode.InvalidParams, 'upstream_bad_request');
  });
});

describe('hostile Markdown fence bounds', () => {
  it('enforces the independently measured assembled 96 KiB boundary including multibyte enrichment', async () => {
    const run = async (padding: number, marker = false) => {
      network(() =>
        envelope([{ code: 'US', name: `雪${'x'.repeat(padding)}`, ...(marker && { x: [0, 0] }) }]),
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
    const oddBaseline = await run(0, true);
    const oddPadding = Math.floor((ceiling - measure(oddBaseline)) / 2);
    const immediatelyBelow = await run(oddPadding, true);
    parity(immediatelyBelow);
    expect(measure(immediatelyBelow)).toBe(ceiling - 1);
    failure(
      await run(oddPadding + 1, true),
      JsonRpcErrorCode.ValidationError,
      'response_too_large',
    );
  });
  it('handles many separate backtick runs without a spread argument overflow', () => {
    const value = { text: '`x'.repeat(150000), nested: { text: '````\r\n雪' } };
    const rendered = renderJson(value);
    const lines = rendered.split('\n');
    expect(lines[0]).toBe('`````json');
    expect(JSON.parse(lines.slice(1, -1).join('\n'))).toEqual(value);
  });
});
