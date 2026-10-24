/**
 * @fileoverview Captured IODA boundaries, exclusions, scope uncertainty and aggregate semantics.
 * @module tests/tools/outage-semantics
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOutages } from '../../src/mcp-server/tools/definitions/find-outages.tool.js';
import { getAlerts } from '../../src/mcp-server/tools/definitions/get-alerts.tool.js';
import { getSignals } from '../../src/mcp-server/tools/definitions/get-signals.tool.js';
import { getStatus } from '../../src/mcp-server/tools/definitions/get-status.tool.js';
import { summarizeOutages } from '../../src/mcp-server/tools/definitions/summarize-outages.tool.js';
import { clampExtendWindow, ignoredMethods } from '../../src/mcp-server/tools/ioda-common.js';
import { disposeIodaService, initIodaService } from '../../src/services/ioda/index.js';
import captures from '../fixtures/outage-contracts.json' with { type: 'json' };

const window = { from: 1792713600, until: 1792800000 };
const calls: URL[] = [];
const tools = [
  [findOutages, 'events'],
  [getAlerts, 'alerts'],
  [summarizeOutages, 'summary'],
] as const;
type Result = Awaited<ReturnType<typeof runToolContract>>;
type Capture = keyof typeof captures;
function network(respond: (url: URL) => unknown) {
  disposeIodaService();
  initIodaService({
    fetch: (async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      expect(url.origin).toBe('https://api.ioda.inetintel.cc.gatech.edu');
      return Response.json({ error: null, data: respond(url) });
    }) as typeof fetch,
  });
}
function rendered(result: Result) {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}
function parity(result: Result) {
  expect(result.isError).not.toBe(true);
  const blocks = [...rendered(result).matchAll(/(`{3,})json\n([\s\S]*?)\n\1/g)].map((match) =>
    JSON.parse(match[2] ?? ''),
  );
  expect(blocks.length).toBeGreaterThan(1);
  expect(Object.assign({}, ...blocks)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1792886400000);
  calls.length = 0;
});
afterEach(() => {
  disposeIodaService();
  vi.useRealTimers();
});

describe('captured pass-through characterization', () => {
  it.each([
    [1792723199, 1792723200, [234]],
    [1792723200, 1792723200, [234]],
    [1792723201, 1792723800, [234, 222]],
  ] as const)(
    'preserves requested and returned signal bounds at %i',
    async (until, returnedUntil, values) => {
      const fixture = captures[`issue-11/probe-raw-${until}` as Capture];
      network(() => fixture);
      const data = parity(
        await runToolContract(getSignals, {
          entityType: 'region',
          entityCode: '1837',
          source: 'ping-slash24',
          from: 1792722600,
          until,
          maxPoints: 2000,
        }),
      );
      expect(data.series).toEqual(fixture[0]);
      expect(data.series).toMatchObject([
        { from: 1792722600, until: returnedUntil, step: 600, nativeStep: 600, values: [...values] },
      ]);
      expect(data.applied).toMatchObject({ until });
      expect(calls).toHaveLength(1);
    },
  );
  it.each([1792723199, 1792723200, 1792723201])(
    'preserves boundary controls at until %i',
    async (until) => {
      for (const [tool, endpoint] of tools) {
        const fixture = captures[`issue-11/probe-${endpoint}-${until}` as Capture];
        network(() => fixture);
        const data = parity(
          await runToolContract(tool, {
            entityType: 'region',
            entityCode: '1837',
            from: 1792722600,
            until,
            extendWindowSeconds: 0,
            ...(endpoint !== 'summary' && { source: 'ping-slash24' }),
          }),
        );
        expect(data[endpoint === 'summary' ? 'summaries' : endpoint]).toEqual(fixture);
        expect(calls.at(-1)?.searchParams.get('until')).toBe(String(until));
        expect(fixture).toHaveLength(until < 1792723200 ? 0 : 1);
      }
      expect(calls).toHaveLength(3);
    },
  );
  it.each([2000, 20])(
    'preserves all captured numeric buckets at maxPoints %i',
    async (maxPoints) => {
      const fixture = captures[`issue-16/probe-raw-${maxPoints}` as Capture];
      network(() => fixture);
      const data = parity(
        await runToolContract(getSignals, {
          ...window,
          entityType: 'region',
          entityCode: '1828',
          source: 'merit-nt',
          maxPoints,
        }),
      );
      expect(data.series).toEqual(fixture[0]);
      expect(data.semantics).toMatchObject({ unit: 'Unique Source IPs' });
      expect(calls).toHaveLength(1);
    },
  );
});

describe('endpoint-specific boundary guidance', () => {
  it.each(['ioda_find_outages', 'ioda_summarize_outages'] as const)(
    '%s extension recovery retains events ending at from',
    (tool) => {
      const served = clampExtendWindow(1209601, tool, window, 1792886400000);
      expect(served.notice).toContain('whose until is at or after 1792713600');
    },
  );
  it('advertises inclusive detection bounds and aligned exclusive returned signal bounds', () => {
    for (const [tool] of tools) {
      expect(tool.input.shape.until.description).toContain('Inclusive');
      expect(tool.description).toContain('boundary');
    }
    expect(getSignals.input.shape.until.description).toContain('Requested');
    expect(getSignals.description).toContain('exclusive');
  });
});

describe('upstream exclusion contract', () => {
  it.each([
    [undefined, 'None', 34, 'LT', 827416.0941834522],
    [['gtr.*'], 'gtr.STAR', 31, 'GU', 189542.77286135696],
    [['*.median'], 'STAR.median', 3, 'LT', 827416.0941834522],
  ] as const)(
    'preserves captured default-extension ranking with exclusions %j',
    async (ignoreMethods, suffix, count, code, overall) => {
      const fixture = captures[`issue-15/probe-default-${suffix}` as Capture];
      network(() => fixture);
      const data = parity(
        await runToolContract(summarizeOutages, {
          ...window,
          entityType: 'country',
          limit: 100,
          ...(ignoreMethods && { ignoreMethods: [...ignoreMethods] }),
        }),
      );
      expect(data.summaries).toEqual(fixture);
      expect(data.summaries).toHaveLength(count);
      expect(data.summaries).toHaveProperty('0.entity.code', code);
      expect(data.summaries).toHaveProperty('0.scores.overall', overall);
      expect(calls[0]?.searchParams.get('extendWindow')).toBe('1209600');
    },
  );
  it.each([
    [['gtr.sarima'], 'gtr.sarima', 17],
    [['*.sarima'], 'STAR.sarima', 17],
    [['gtr.*', 'bgp.median'], 'gtr.STAR,bgp.median', 1],
  ] as const)(
    'preserves upstream exact and combined exclusion result %j',
    async (ignoreMethods, suffix, count) => {
      const fixture = captures[`issue-15/probe-grammar-${suffix}` as Capture];
      network(() => fixture);
      const data = parity(
        await runToolContract(summarizeOutages, {
          ...window,
          entityType: 'country',
          extendWindowSeconds: 0,
          limit: 100,
          ignoreMethods: [...ignoreMethods],
        }),
      );
      expect(data.summaries).toEqual(fixture);
      expect(data.summaries).toHaveLength(count);
      expect(calls[0]?.searchParams.get('ignoreMethods')).toBe(ignoreMethods.join(','));
    },
  );
  it.each([findOutages, getAlerts])(
    '%s permits a method-level exclusion leaving no detections',
    async (tool) => {
      network(() => []);
      const data = parity(
        await runToolContract(tool, {
          ...window,
          entityType: 'country',
          source: 'bgp',
          ignoreMethods: ['bgp.median'],
        }),
      );
      expect(data.applied).toMatchObject({ source: 'bgp', ignoreMethods: ['bgp.median'] });
      expect(data.notice).not.toContain('Membership coverage');
      expect(calls).toHaveLength(1);
    },
  );
  it.each(tools)(
    '%s advertises executable item patterns with actionable rejection',
    async (tool) => {
      const properties = z.toJSONSchema(tool.input).properties as Record<
        string,
        { items?: { pattern?: string } }
      >;
      const pattern = properties.ignoreMethods?.items?.pattern;
      expect(pattern).toBeTypeOf('string');
      const regex = new RegExp(pattern ?? '');
      for (const valid of [' GTR.* ', '*.median', 'bgp.future-method_2', 'MERIT-NT.MEDIAN'])
        expect(regex.test(valid)).toBe(true);
      for (const invalid of [
        '*.*',
        '',
        'gtr',
        'gtr.',
        '.median',
        'unknown.*',
        'gtr.*,bgp.median',
        'gtr.*|bgp.median',
        'gtr.me\ndian',
        'gtr.a.b',
      ]) {
        expect(regex.test(invalid)).toBe(false);
        network(() => []);
        const result = await runToolContract(tool, {
          ...window,
          entityType: 'country',
          ignoreMethods: [invalid],
        });
        expect(calls).toHaveLength(0);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(rendered(result)).toContain('\\<source>.\\<method>');
        expect(calls).toHaveLength(0);
      }
    },
  );
  it.each(tools)(
    '%s sends normalized exclusions before upstream scoring and preserves captures',
    async (tool, endpoint) => {
      for (const [ignoreMethods, suffix, count] of [
        [undefined, 'None', endpoint === 'events' ? 27 : endpoint === 'alerts' ? 50 : 19],
        [
          [' GTR.* ', 'gtr.*'],
          'gtr.STAR',
          endpoint === 'events' ? 25 : endpoint === 'alerts' ? 46 : 17,
        ],
        [[' *.MEDIAN '], 'STAR.median', endpoint === 'events' ? 2 : endpoint === 'alerts' ? 4 : 2],
      ] as const) {
        const fixture = captures[`issue-15/probe-${endpoint}-${suffix}` as Capture];
        network(() => fixture);
        const data = parity(
          await runToolContract(tool, {
            ...window,
            entityType: 'country',
            extendWindowSeconds: 0,
            limit: 100,
            ...(ignoreMethods && { ignoreMethods: [...ignoreMethods] }),
          }),
        );
        expect(calls.at(-1)?.searchParams.get('ignoreMethods')).toBe(
          suffix === 'None' ? null : suffix === 'gtr.STAR' ? 'gtr.*' : '*.median',
        );
        expect(data[endpoint === 'summary' ? 'summaries' : endpoint]).toEqual(fixture);
        expect(fixture).toHaveLength(count);
        if (ignoreMethods)
          expect(data.applied).toMatchObject({
            ignoreMethods: [suffix === 'gtr.STAR' ? 'gtr.*' : '*.median'],
          });
      }
      expect(calls).toHaveLength(3);
    },
  );
  it.each([findOutages, getAlerts])(
    '%s rejects an explicit whole-source conflict before HTTP',
    async (tool) => {
      network(() => []);
      const result = await runToolContract(tool, {
        ...window,
        source: ' BGP ',
        ignoreMethods: [' BGP.* '],
      });
      expect(calls).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_ignore_methods' },
        },
      });
      const entry = tool.errors?.find((item) => item.reason === 'invalid_ignore_methods');
      expect(entry?.recovery).toContain('ignoreMethods');
      expect(result.structuredContent).toMatchObject({
        error: { data: { recovery: { hint: entry?.recovery } } },
      });
      expect(rendered(result)).toContain(entry?.recovery.replaceAll('*', '\\*'));
      expect(calls).toHaveLength(0);
    },
  );
  it.each(tools)(
    '%s keeps exclusions across full, short and past-end pages and omits an empty array upstream',
    async (tool, endpoint) => {
      const row = captures[`issue-15/probe-${endpoint}-None` as Capture][0];
      for (const page of [0, 1, 2, 3]) {
        network(() => (page === 0 ? [row, row] : page === 1 ? [row] : []));
        const data = parity(
          await runToolContract(tool, {
            ...window,
            entityType: 'country',
            extendWindowSeconds: 0,
            limit: 2,
            page,
            ignoreMethods: page === 3 ? [] : [' GTR.* ', 'bgp.MEDIAN', 'gtr.*'],
          }),
        );
        expect(calls.at(-1)?.searchParams.get('ignoreMethods')).toBe(
          page === 3 ? null : 'gtr.*,bgp.median',
        );
        expect(data.applied).toMatchObject({
          ignoreMethods: page === 3 ? [] : ['gtr.*', 'bgp.median'],
          page,
          limit: 2,
        });
        expect(data.pagination).toMatchObject({
          returned: page === 0 ? 2 : page === 1 ? 1 : 0,
          more: page === 0 ? 'possible' : 'no',
        });
      }
      expect(calls).toHaveLength(4);
    },
  );
});

describe('unverified related membership', () => {
  it.each([
    ['scope', 24, '30567', 23500],
    ['member', 1, '10680', 29020],
  ] as const)(
    'preserves captured %s ranking while qualifying only scoped membership',
    async (kind, count, code, overall) => {
      const fixture = captures[`issue-13/probe-${kind}-summary`];
      network(() => fixture);
      const data = parity(
        await runToolContract(summarizeOutages, {
          ...window,
          entityType: 'asn',
          extendWindowSeconds: 0,
          limit: 100,
          ...(kind === 'scope'
            ? { relatedToType: 'country', relatedToCode: 'US' }
            : { entityCode: '10680' }),
        }),
      );
      expect(data.summaries).toEqual(fixture);
      expect(data.summaries).toHaveLength(count);
      expect(data.summaries).toHaveProperty('0.entity.code', code);
      expect(data.summaries).toHaveProperty('0.scores.overall', overall);
      expect(data.pagination).toMatchObject({ more: 'no' });
      if (kind === 'scope') expect(data.notice).toContain('Membership coverage is unverified');
      else expect(data.notice).toBeUndefined();
      expect(calls).toHaveLength(1);
    },
  );
  describe.each(tools)('%s without exclusions', (tool, endpoint) => {
    it.each([0, 1, 2])('warns on a scoped page with %i rows', async (count) => {
      const row = captures[`issue-15/probe-${endpoint}-None` as Capture][0];
      network(() => Array.from({ length: count }, () => row));
      const data = parity(
        await runToolContract(tool, {
          ...window,
          entityType: 'country',
          relatedToType: 'asn',
          relatedToCode: '123',
          extendWindowSeconds: 0,
          limit: 2,
        }),
      );
      expect(data.notice).toContain('Membership coverage is unverified');
      expect(data.pagination).toMatchObject({ more: count === 2 ? 'possible' : 'no' });
      expect(calls).toHaveLength(1);
    });
  });
  it.each(tools)(
    '%s warns independently of row-page fullness and gives complete recovery',
    async (tool, endpoint) => {
      const row = captures[`issue-15/probe-${endpoint}-None` as Capture][0];
      for (const count of [0, 1, 2]) {
        network(() => Array.from({ length: count }, () => row));
        const data = parity(
          await runToolContract(tool, {
            ...window,
            entityType: 'country',
            relatedToType: 'asn',
            relatedToCode: ' AS123 ',
            extendWindowSeconds: 1234,
            limit: 2,
            ignoreMethods: [' GTR.* '],
            ...(endpoint !== 'summary' && { source: 'bgp' }),
            ...(endpoint === 'events' && { includeAlerts: true }),
          }),
        );
        expect(data.notice).toContain('Membership coverage is unverified');
        expect(data.notice).toContain('ioda_search_entities');
        expect(data.notice).toContain('"relatedToType":"asn","relatedToCode":"123"');
        expect(data.notice).toContain('"page":0,"limit":2');
        expect(data.notice).toContain('"from":1792713600,"until":1792800000');
        expect(data.notice).toContain('"ignoreMethods":["gtr.*"]');
        expect(data.notice).toContain('"extendWindowSeconds":1234');
        if (endpoint !== 'summary') expect(data.notice).toContain('"source":"bgp"');
        if (endpoint === 'events') expect(data.notice).toContain('"includeAlerts":true');
        expect(data.notice).toContain('remove relatedToType and relatedToCode');
        expect(data.pagination).toMatchObject({ more: count === 2 ? 'possible' : 'no' });
        expect(calls).toHaveLength(count + 1);
      }
    },
  );
});

describe('coarse aggregate interpretation', () => {
  it('keeps status coverage unknown and exposes compatible limitations on both surfaces', async () => {
    vi.setSystemTime(1792800000000);
    network((url) =>
      url.pathname.includes('/signals/raw/')
        ? url.searchParams.get('datasource') === 'merit-nt'
          ? captures['issue-16/probe-raw-20']
          : [[]]
        : [],
    );
    const pending = runToolContract(getStatus, {
      entityType: 'region',
      entityCode: '1828',
      lookbackHours: 24,
    });
    await vi.advanceTimersByTimeAsync(10000);
    const data = parity(await pending);
    expect(data.signals).toContainEqual(
      expect.objectContaining({
        source: 'merit-nt',
        coverage: 'unknown',
        unit: 'Unique Source IPs',
      }),
    );
    expect(data.limitations).toContain(
      'Coarser aggregate buckets cannot establish current coverage: upstream aggregates underlying samples, so values need not equal an unweighted mean of finer returned buckets and non-null aggregates cannot establish complete finer-resolution coverage. Inspect ioda_get_signals over a narrower window.',
    );
    expect(calls).toHaveLength(5);
  });
  it('preserves the captured weighting difference and finer missing observations', async () => {
    const fine = captures['issue-16/probe-raw-2000'][0]?.[0];
    const coarse = captures['issue-16/probe-raw-20'][0]?.[0];
    if (!fine || !coarse) throw new Error('Missing captured series');
    expect(fine.values.slice(0, 24)).not.toContain(null);
    expect(
      fine.values.slice(0, 24).reduce<number>((sum, value) => sum + Number(value), 0) / 24,
    ).toBe(0.46875);
    expect(coarse.values[0]).toBe(0.46153846153846156);
    expect(fine.values.filter((value) => value === null)).toHaveLength(7);
    expect(coarse.values.filter((value) => value === null)).toHaveLength(0);
    network(() => [[fine, coarse]]);
    const data = parity(
      await runToolContract(getSignals, {
        ...window,
        entityType: 'region',
        entityCode: '1828',
        source: 'merit-nt',
      }),
    );
    expect(data.series).toEqual([fine, coarse]);
    expect(data.notice).toContain('finer-resolution coverage');
    expect(calls).toHaveLength(1);
  });
  it.each([2000, 20])(
    'qualifies only coarse series at maxPoints %i without changing observations',
    async (maxPoints) => {
      const fixture = captures[`issue-16/probe-raw-${maxPoints}` as Capture];
      network(() => fixture);
      const data = parity(
        await runToolContract(getSignals, {
          ...window,
          entityType: 'region',
          entityCode: '1828',
          source: 'merit-nt',
          maxPoints,
        }),
      );
      expect(data.series).toEqual(fixture[0]);
      expect(data.semantics).toMatchObject({ unit: 'Unique Source IPs' });
      if (maxPoints === 20) {
        expect(data.notice).toContain('unweighted mean');
        expect(data.notice).toContain('finer-resolution coverage');
      } else expect(data.notice).toBeUndefined();
      expect(calls).toHaveLength(1);
    },
  );
});

describe('exclusion scan CPU growth', () => {
  function fastest(run: () => unknown) {
    run();
    let fastestUs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = process.threadCpuUsage();
      for (let pass = 0; pass < 10; pass++) run();
      const used = process.threadCpuUsage(start);
      fastestUs = Math.min(fastestUs, used.user + used.system);
    }
    return fastestUs;
  }
  it.each([
    ['long method', 5000, (n: number) => `gtr.${'a'.repeat(n)}`],
    ['trailing separator', 1250, (n: number) => `gtr.${'a'.repeat(n)}.`],
    ['long line ending in a break', 1250, (n: number) => `gtr.${'a'.repeat(n)}\nx`],
    ['breaks throughout', 1250, (n: number) => `${' \r\n'.repeat(n)}gtr.*`],
  ])('%s stays bounded over 64× input', (_, start, shape) => {
    const properties = z.toJSONSchema(findOutages.input).properties as Record<
      string,
      { items?: { pattern?: string } }
    >;
    const pattern = properties.ignoreMethods?.items?.pattern;
    if (!pattern) throw new Error('Missing exclusion pattern');
    const regex = new RegExp(pattern);
    for (const operation of [
      (input: string) => regex.test(input),
      (input: string) => ignoredMethods([input]),
    ]) {
      const samples: number[] = [];
      for (let size = start; size <= start * 64; size *= 2) {
        const input = shape(size);
        const cpuUs = fastest(() => operation(input));
        expect(cpuUs, `${size}`).toBeLessThan(250000);
        samples.push(cpuUs);
      }
      expect(samples).toHaveLength(7);
      expect((samples[6] ?? 0) / Math.max(samples[0] ?? 0, 1)).toBeLessThan(256);
    }
  });
});
