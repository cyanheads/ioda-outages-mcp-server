/**
 * @fileoverview Injected network and shared pacing boundaries.
 * @module tests/services/ioda-service
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryFor } from '../../src/services/ioda/errors.js';
import { IodaService } from '../../src/services/ioda/ioda-service.js';
import type { StatusEvidence } from '../../src/services/ioda/schemas.js';

const input = { entityType: 'country' as const, page: 0, limit: 1 };
const instances: IodaService[] = [];
const envelope = (data: unknown) => Response.json({ error: null, data });
const budget = () => ({ deadline: Date.now() + 45000 });
function service(fetcher: (request: URL | string) => Promise<Response>) {
  const instance = new IodaService({ fetch: fetcher as typeof fetch });
  instances.push(instance);
  return instance;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1792540800000);
});
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.useRealTimers();
});
type StatusRoute = 'events' | 'alerts' | 'bgp' | 'ping-slash24' | 'merit-nt';
type Responder = () => Response | Promise<Response>;
const unexpected: string[] = [];
afterEach(() => {
  expect(unexpected.splice(0)).toEqual([]);
});
/**
 * A fetch fake answering IODA's events and alerts paths and one entity's raw signals path, routed
 * by hostname, pathname, and datasource. Any other request is recorded and rejected.
 */
function statusFetch(
  routes: Partial<Record<StatusRoute, Responder>>,
  signalsPath = '/v2/signals/raw/country/ZZ',
) {
  return vi.fn(async (request: URL | string) => {
    const url = new URL(String(request));
    const route =
      url.hostname !== 'api.ioda.inetintel.cc.gatech.edu'
        ? undefined
        : url.pathname === '/v2/outages/events'
          ? 'events'
          : url.pathname === '/v2/outages/alerts'
            ? 'alerts'
            : url.pathname === signalsPath
              ? url.searchParams.get('datasource')
              : undefined;
    const respond =
      route && Object.hasOwn(routes, route) ? routes[route as StatusRoute] : undefined;
    if (respond) return respond();
    unexpected.push(url.href);
    throw new Error(`Unmocked IODA request: ${url.href}`);
  });
}
const empty = () => envelope([]);
const noSeries = () => envelope([[]]);
/** Settles a call while fake time passes every paced exchange of one status collection. */
async function settle<T>(pending: Promise<T>) {
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(10000);
  return outcome;
}
describe('network seam', () => {
  it('preserves extended events, clipped ends, nested transitions and null baselines', async () => {
    const entity = { code: 'US', name: 'US', type: null };
    const alert = {
      entity,
      datasource: 'bgp',
      time: 1200,
      level: 'critical',
      value: 0,
      historyValue: null,
      condition: 'a\nb',
      extra: { nested: [1, null] },
    };
    const event = {
      entity,
      from: 1,
      until: 2000,
      score: 3,
      alerts: [alert],
      details: { array: [{ deep: true }] },
    };
    const request = {
      from: 1000,
      until: 2000,
      page: 0,
      limit: 1,
      includeAlerts: true,
      extendWindowSeconds: 1209600,
    };
    const result = await service(async () => envelope([event])).getEvents(
      request,
      createMockContext(),
      budget(),
    );
    expect(result.events).toEqual([event]);
    const alerts = await service(async () => envelope([alert])).getAlerts(
      { from: 1000, until: 2000, page: 0, limit: 1, extendWindowSeconds: 0 },
      createMockContext(),
      budget(),
    );
    expect(alerts.alerts).toEqual([alert]);
  });
  it('paces shared calls and removes a cancelled queued invocation', async () => {
    const starts: number[] = [];
    const instance = service(async () => {
      starts.push(Date.now());
      return envelope([]);
    });
    await instance.searchEntities(input, createMockContext(), budget());
    const controller = new AbortController();
    const cancelled = expect(
      instance.searchEntities(input, createMockContext({ signal: controller.signal }), budget()),
    ).rejects.toMatchObject({ data: { reason: 'request_cancelled' } });
    controller.abort();
    await cancelled;
    const next = instance.searchEntities(input, createMockContext(), budget());
    await vi.advanceTimersByTimeAsync(1999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts[1]! - starts[0]!).toBe(2000);
  });
  it('bounds pending upstream work to twenty and distinguishes queue rejection', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    const instance = service(fetcher);
    const pending = Array.from({ length: 22 }, () =>
      instance
        .searchEntities(input, createMockContext({ signal: controller.signal }), budget())
        .catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.data?.reason === 'upstream_queue_full')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.data?.reason === 'request_cancelled')).toHaveLength(
      21,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps aligned samples above maxPoints and rejects contradictory intervals', async () => {
    const record = {
      entityType: 'country',
      entityCode: 'US',
      datasource: 'bgp',
      from: 900,
      until: 6300,
      step: 1800,
      nativeStep: 300,
      values: [0, null, 7],
    };
    const request = {
      entityType: 'country' as const,
      entityCode: 'US',
      source: 'bgp' as const,
      from: 1000,
      until: 6000,
      maxPoints: 2,
    };
    const result = await service(async () => envelope([[record]])).getNumericSignals(
      request,
      createMockContext(),
      budget(),
    );
    expect(result.series).toEqual([record]);
    await expect(
      service(async () => envelope([[{ ...record, until: 8100 }]])).getNumericSignals(
        request,
        createMockContext(),
        budget(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_schema' } });
    await expect(
      service(async () =>
        envelope([[{ ...record, values: [0, { nested: 1 }, 7] }]]),
      ).getNumericSignals(request, createMockContext(), budget()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_schema' } });
  });
  it('returns partial status with independent failed and successful components', async () => {
    let calls = 0;
    const instance = service(async () => {
      calls++;
      if (calls === 1) return new Response('missing', { status: 404 });
      return envelope(calls === 2 ? [] : [[]]);
    });
    const pending = instance.getStatusEvidence(
      { entityType: 'country', entityCode: 'US', asOf: 1792540800, lookbackHours: 1 },
      createMockContext(),
      budget(),
    );
    await vi.advanceTimersByTimeAsync(10000);
    const result = await pending;
    expect(result.detection).toBe('unknown');
    expect(result).not.toHaveProperty('events');
    expect(result.alerts?.items).toEqual([]);
    expect(result.components.map((item) => [item.component, item.state])).toEqual([
      ['events', 'failed'],
      ['alerts', 'ok'],
      ['bgp', 'ok'],
      ['ping-slash24', 'ok'],
      ['merit-nt', 'ok'],
    ]);
    expect(result.signals.map((item) => item.coverage)).toEqual(['no_data', 'no_data', 'no_data']);
    expect(result.signals.map(({ source, unit }) => [source, unit])).toEqual([
      ['bgp', 'Visible /24s'],
      ['ping-slash24', 'Up /24s'],
      ['merit-nt', 'Unique Source IPs'],
    ]);
  });
  it('throws the first fixed-order error when all status components fail', async () => {
    const fetcher = statusFetch(
      {
        events: () => new Response('denied', { status: 403 }),
        alerts: () => new Response('denied', { status: 401 }),
        bgp: () => new Response('', { status: 422 }),
        'ping-slash24': () => new Response('', { status: 400 }),
        'merit-nt': () => new Response('', { status: 429 }),
      },
      '/v2/signals/raw/country/US',
    );
    const { error } = (await settle(
      service(fetcher).getStatusEvidence(
        { entityType: 'country', entityCode: 'US', asOf: 1792540800, lookbackHours: 1 },
        createMockContext(),
        budget(),
      ),
    )) as { error: McpError };
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.message).toBe('IODA returned HTTP 403.');
    expect(error.data).toEqual({
      reason: 'upstream_forbidden',
      status: 403,
      recovery: {
        hint: 'The keyless public endpoint refused access. Retry ioda_find_outages later; no API key is required.',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('shares the deadline across status components and cancels unstarted work', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls === 1 ? envelope([]) : new Promise<Response>(() => {});
    });
    const pending = service(fetcher).getStatusEvidence(
      { entityType: 'country', entityCode: 'US', asOf: 1792540800, lookbackHours: 1 },
      createMockContext(),
      { deadline: Date.now() + 7000 },
    );
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.components.filter((item) => item.state === 'failed')).toHaveLength(4);
    expect(
      result.components.slice(1).every((item) => item.failure?.reason === 'upstream_timeout'),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves nested sparse metadata and full-page ambiguity', async () => {
    const entity = { code: 'US', name: 'US', attrs: { nested: [null, 0, { preserve: true }] } };
    const result = await service(async () => envelope([entity])).searchEntities(
      input,
      createMockContext(),
      budget(),
    );
    expect(result.entities).toEqual([entity]);
    expect(result.pagination).toEqual({
      page: 0,
      limit: 1,
      returned: 1,
      more: 'possible',
      nextPage: 1,
    });
  });
  it('returns an empty page past the end', async () => {
    const result = await service(async () => envelope([])).searchEntities(
      { ...input, page: 999 },
      createMockContext(),
      budget(),
    );
    expect(result.pagination).toEqual({ page: 999, limit: 1, returned: 0, more: 'no' });
  });
  it.each([
    [400, 'upstream_bad_request'],
    [422, 'upstream_unprocessable'],
    [401, 'upstream_unauthorized'],
    [403, 'upstream_forbidden'],
    [404, 'entity_not_found'],
    [429, 'upstream_rate_limited'],
  ] as const)('classifies HTTP %s without retry', async (status, reason) => {
    const fetcher = vi.fn(
      async () => new Response('secret body', { status, headers: { 'retry-after': '17' } }),
    );
    await expect(
      service(fetcher).searchEntities(input, createMockContext(), budget()),
    ).rejects.toMatchObject({
      data: { reason, status, recovery: { hint: expect.stringContaining('ioda_search_entities') } },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{ data: [], error: 'failure' }, { data: {} }, { wrong: [] }])(
    'rejects unsafe envelopes %#',
    async (body) => {
      await expect(
        service(async () => Response.json(body)).searchEntities(
          input,
          createMockContext(),
          budget(),
        ),
      ).rejects.toMatchObject({
        data: { reason: expect.stringMatching(/^upstream_(schema|bad_request)$/) },
      });
    },
  );
  it('cancels an oversized streaming body without retry', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2097153));
            },
            cancel,
          }),
        ),
    );
    await expect(
      service(fetcher).searchEntities(input, createMockContext(), budget()),
    ).rejects.toMatchObject({ data: { reason: 'response_too_large' } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retries transient HTTP only after two seconds', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('gateway', { status: 502 }))
      .mockImplementation(async () => envelope([]));
    const pending = service(fetcher).searchEntities(input, createMockContext(), budget());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires a hanging exchange under one absolute deadline', async () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    const pending = service(fetcher).searchEntities(input, createMockContext(), {
      deadline: Date.now() + 4000,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      data: { reason: 'upstream_timeout' },
    });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

/** IODA's HTTP 400 for a country or region code with no metadata entity, trimmed from a live reply. */
const missingEntity = {
  type: 'signals',
  error: 'cannot find corresponding metadata entity 0',
  perf: null,
  data: null,
  copyright:
    'This data is Copyright (c) 2021-2025 Georgia Tech Research Corporation. All Rights Reserved.',
};
const missingEntityMessage = 'IODA has no metadata entity for this entityType and entityCode.';
const signalRequest = {
  entityType: 'country' as const,
  entityCode: 'ZZ',
  source: 'bgp' as const,
  from: 1792537200,
  until: 1792540800,
  maxPoints: 2000,
};
const statusRequest = {
  entityType: 'country' as const,
  entityCode: 'ZZ',
  asOf: 1792540800,
  lookbackHours: 1,
};
const statusNotFoundHint =
  'Call ioda_search_entities with entityType and the name as query, then retry ioda_get_status with the selected entityType and a returned code as entityCode.';
const notFound = () => Response.json(missingEntity, { status: 400 });
describe('missing metadata entity', () => {
  it('classifies the metadata-entity 400 as entity_not_found once, without upstream text', async () => {
    const fetcher = statusFetch({ bgp: notFound });
    const { error } = (await settle(
      service(fetcher).getNumericSignals(signalRequest, createMockContext(), budget()),
    )) as { error: McpError };
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(missingEntityMessage);
    expect(error.data).toEqual({
      reason: 'entity_not_found',
      status: 400,
      recovery: {
        hint: 'Call ioda_search_entities with entityType and the name as query, then retry ioda_get_signals with the selected entityType and a returned code as entityCode.',
      },
    });
    expect(JSON.stringify(error.data)).not.toContain('cannot find');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('classifies the metadata-entity 400 on the attempt after a transient failure', async () => {
    let attempts = 0;
    const fetcher = statusFetch({
      bgp: () => (attempts++ === 0 ? new Response('gateway', { status: 503 }) : notFound()),
    });
    const { error } = (await settle(
      service(fetcher).getNumericSignals(signalRequest, createMockContext(), budget()),
    )) as { error: McpError };
    expect(error.data?.reason).toBe('entity_not_found');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    [
      'invalid datasource',
      Response.json(
        {
          error:
            'invalid datasource foo (must be one of the following [gtr, gtr-sarima, gtr-norm, merit-nt, bgp, ping-slash24, ping-slash24-loss, ping-slash24-latency, upstream-delay-penult-asns, upstream-delay-penult-e2e-latency, mozilla])',
          data: null,
        },
        { status: 400 },
      ),
    ],
    [
      'reversed window',
      Response.json(
        { error: 'from (1792560768) must be earlier than until (1792557168)', data: null },
        { status: 400 },
      ),
    ],
    ['non-JSON', new Response('cannot find corresponding metadata entity 0', { status: 400 })],
    ['empty', new Response('', { status: 400 })],
    ['bodiless', new Response(null, { status: 400 })],
    [
      'prefix elsewhere',
      Response.json(
        { error: 'lookup failed: cannot find corresponding metadata entity 0', data: null },
        { status: 400 },
      ),
    ],
    [
      'non-string error',
      Response.json(
        { error: { message: 'cannot find corresponding metadata entity 0' }, data: null },
        { status: 400 },
      ),
    ],
    [
      'oversized',
      new Response(
        `{"error":"cannot find corresponding metadata entity 0","pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
        { status: 400 },
      ),
    ],
  ])('keeps a %s HTTP 400 as upstream_bad_request without retry', async (_, response) => {
    const fetcher = statusFetch({ bgp: () => response });
    const { error } = (await settle(
      service(fetcher).getNumericSignals(signalRequest, createMockContext(), budget()),
    )) as { error: McpError };
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toBe('IODA returned HTTP 400.');
    expect(error.data).toMatchObject({ reason: 'upstream_bad_request', status: 400 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    [200, 'upstream_bad_request', 'IODA rejected the request in its response envelope.'],
    [422, 'upstream_unprocessable', 'IODA returned HTTP 422.'],
  ] as const)(
    'classifies the metadata-entity text under HTTP %i by its status',
    async (status, reason, message) => {
      const fetcher = statusFetch({ bgp: () => Response.json(missingEntity, { status }) });
      const { error } = (await settle(
        service(fetcher).getNumericSignals(signalRequest, createMockContext(), budget()),
      )) as { error: McpError };
      expect(error.message).toBe(message);
      expect(error.data?.reason).toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  /** A 400 whose body starts the missing-entity envelope and never finishes. */
  const stalledBody = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"cannot find corresponding'));
        },
      }),
      { status: 400 },
    );
  it('reports caller cancellation while a 400 body streams, never a classified failure', async () => {
    const controller = new AbortController();
    const fetcher = statusFetch({ bgp: stalledBody });
    const pending = service(fetcher).getNumericSignals(
      signalRequest,
      createMockContext({ signal: controller.signal }),
      budget(),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: { reason: 'request_cancelled' },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledOnce();
    controller.abort();
    await assertion;
  });
  it('times out a 400 body that outlives the collection deadline', async () => {
    const fetcher = statusFetch({ bgp: stalledBody });
    const pending = service(fetcher).getNumericSignals(signalRequest, createMockContext(), {
      deadline: Date.now() + 4000,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('throws entity_not_found from status when signals report it and nothing else returned', async () => {
    const fetcher = statusFetch({
      events: empty,
      alerts: empty,
      bgp: notFound,
      'ping-slash24': notFound,
      'merit-nt': notFound,
    });
    const { error } = (await settle(
      service(fetcher).getStatusEvidence(statusRequest, createMockContext(), budget()),
    )) as { error: McpError };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(missingEntityMessage);
    expect(error.data).toEqual({
      reason: 'entity_not_found',
      status: 400,
      recovery: { hint: statusNotFoundHint },
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it.each([
    [
      'one signal not found beside other signal failures',
      { bgp: notFound, 'ping-slash24': () => new Response('', { status: 422 }) },
      missingEntityMessage,
      400,
    ],
    [
      'every component failed, a signal not found',
      {
        events: () => new Response('', { status: 422 }),
        alerts: () => new Response('', { status: 403 }),
        'ping-slash24': () => new Response('', { status: 422 }),
        'merit-nt': () => new Response('', { status: 422 }),
      },
      missingEntityMessage,
      400,
    ],
    [
      'every component a 404',
      Object.fromEntries(
        (['events', 'alerts', 'bgp', 'ping-slash24', 'merit-nt'] as const).map((route) => [
          route,
          () => new Response('missing', { status: 404 }),
        ]),
      ),
      'IODA returned HTTP 404.',
      404,
    ],
  ] as const)(
    'prefers entity_not_found over partial or first-component errors: %s',
    async (_, routes, message, status) => {
      const fetcher = statusFetch({
        events: empty,
        alerts: empty,
        bgp: notFound,
        'ping-slash24': noSeries,
        'merit-nt': notFound,
        ...routes,
      });
      const { error } = (await settle(
        service(fetcher).getStatusEvidence(statusRequest, createMockContext(), budget()),
      )) as { error: McpError };
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(message);
      expect(error.data).toEqual({
        reason: 'entity_not_found',
        status,
        recovery: { hint: statusNotFoundHint },
      });
    },
  );
  /** Record shapes follow live IODA events, alerts, and raw signals replies. */
  const entity = {
    code: 'ZZ',
    name: 'ZZ',
    subnames: [],
    type: 'country',
    attrs: { fqid: 'geo.netacuity.NA.ZZ' },
  };
  const event = {
    entity,
    from: 1792537200,
    until: 1792540800,
    score: 3,
    datasource: 'bgp',
    method: 'median',
  };
  /** A recovery transition: its normal level is not a detection. */
  const alert = {
    datasource: 'bgp',
    entity,
    time: 1792537200,
    level: 'normal',
    condition: 'normal',
    value: 570,
    historyValue: 570,
    method: 'median',
  };
  const series = {
    entityType: 'country',
    entityCode: 'ZZ',
    entityName: 'ZZ',
    entityFqid: 'geo.provider.NA.ZZ',
    datasource: 'ping-slash24',
    subtype: '',
    from: 1792537200,
    until: 1792540800,
    step: 600,
    nativeStep: 600,
    values: [1, 2, 3, 4, 5, 6],
  };
  it.each([
    ['an event', { events: () => envelope([event]) }, 'observed', 'no_data'],
    ['an alert', { alerts: () => envelope([alert]) }, 'unknown', 'no_data'],
    ['a series', { 'ping-slash24': () => envelope([[series]]) }, 'none_returned', 'recent'],
  ] as const)(
    'keeps partial evidence beside %s with the entity_not_found component reason',
    async (_, routes, detection, probingCoverage) => {
      const fetcher = statusFetch({
        events: empty,
        alerts: empty,
        bgp: notFound,
        'ping-slash24': noSeries,
        'merit-nt': notFound,
        ...routes,
      });
      const { value } = (await settle(
        service(fetcher).getStatusEvidence(statusRequest, createMockContext(), budget()),
      )) as { value: StatusEvidence };
      expect(value.detection).toBe(detection);
      const failed = value.components.filter((component) => component.state === 'failed');
      expect(failed.map((component) => component.component)).toEqual(['bgp', 'merit-nt']);
      for (const component of failed)
        expect(component.failure).toEqual({
          code: JsonRpcErrorCode.NotFound,
          reason: 'entity_not_found',
          message: missingEntityMessage,
          recovery: `Call ioda_search_entities with entityType and the name as query, then retry ioda_get_signals with the selected entityType and a returned code as entityCode. Use source ${component.component}.`,
        });
      expect(
        value.signals.map(({ source, unit, coverage }) => ({ source, unit, coverage })),
      ).toEqual([
        { source: 'bgp', unit: 'Visible /24s', coverage: 'unknown' },
        { source: 'ping-slash24', unit: 'Up /24s', coverage: probingCoverage },
        { source: 'merit-nt', unit: 'Unique Source IPs', coverage: 'unknown' },
      ]);
    },
  );
  it('keeps a real entity lacking every source as successful evidence', async () => {
    const fetcher = statusFetch({
      events: empty,
      alerts: empty,
      bgp: noSeries,
      'ping-slash24': noSeries,
      'merit-nt': noSeries,
    });
    const { value } = (await settle(
      service(fetcher).getStatusEvidence(statusRequest, createMockContext(), budget()),
    )) as { value: StatusEvidence };
    expect(value.detection).toBe('none_returned');
    expect(value.components.map((component) => component.state)).toEqual(Array(5).fill('ok'));
    expect(value.signals.map((item) => item.coverage)).toEqual(Array(3).fill('no_data'));
  });
});

describe('status publication allowance', () => {
  const alignment =
    'Nonempty series without completed in-window buckets have unknown coverage because of bucket alignment.';
  /** merit-nt for country/US, read live 2026-10-21 05:56:01 UTC: no bucket published for 56 minutes. */
  const stalled = {
    entityType: 'country',
    entityCode: 'US',
    entityName: 'United States',
    entityFqid: 'geo.provider.NA.US',
    datasource: 'merit-nt',
    subtype: '',
    from: 1792554900,
    until: 1792562400,
    step: 300,
    nativeStep: 300,
    values: [
      4390.4,
      4438.6,
      4520.4,
      4489,
      4425.2,
      4402.2,
      4359.4,
      4333.8,
      4437.8,
      4453.4,
      4492,
      4460.2,
      4399.8,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  };
  const us = { entityType: 'country' as const, entityCode: 'US', lookbackHours: 2 };
  const bucketed = (datasource: string, from: number, values: (number | null)[]) => ({
    entityType: 'country',
    entityCode: 'US',
    entityName: 'United States',
    entityFqid: 'geo.provider.NA.US',
    datasource,
    subtype: '',
    from,
    until: from + values.length * 300,
    step: 300,
    nativeStep: 300,
    values,
  });
  it('names the allowance in the stale limitation and splits overdue from pending buckets', async () => {
    const asOf = 1792562161;
    const fetcher = statusFetch(
      {
        events: empty,
        alerts: empty,
        bgp: noSeries,
        'ping-slash24': noSeries,
        'merit-nt': () => envelope([[stalled]]),
      },
      '/v2/signals/raw/country/US',
    );
    const { value } = (await settle(
      service(fetcher).getStatusEvidence({ ...us, asOf }, createMockContext(), budget()),
    )) as { value: StatusEvidence };
    const merit = value.signals[2];
    expect(merit?.coverage).toBe('stale');
    expect(merit?.series).toHaveLength(1);
    expect(merit?.series[0]).toMatchObject({ nonNullCount: 12, nullCount: 5, pendingCount: 6 });
    expect(value.limitations).toContain(
      'Stale means the latest completed bucket ended more than the 1800-second publication allowance before asOf; this server policy is not an upstream SLA.',
    );
    expect(value.limitations).not.toContain(alignment);
  });
  it('reads a pending-only series as unknown without the alignment limitation', async () => {
    const asOf = 1792562100;
    const fetcher = statusFetch(
      {
        events: empty,
        alerts: empty,
        bgp: () => envelope([[bucketed('bgp', asOf - 600, [null, null])]]),
        'ping-slash24': noSeries,
        'merit-nt': noSeries,
      },
      '/v2/signals/raw/country/US',
    );
    const { value } = (await settle(
      service(fetcher).getStatusEvidence(
        { ...us, lookbackHours: 1, asOf },
        createMockContext(),
        budget(),
      ),
    )) as { value: StatusEvidence };
    expect(value.signals[0]).toMatchObject({
      coverage: 'unknown',
      series: [{ coverage: 'unknown', nonNullCount: 0, nullCount: 0, pendingCount: 2 }],
    });
    expect(value.limitations).not.toContain(alignment);
    expect(value.limitations.some((item) => item.startsWith('Stale means'))).toBe(false);
  });
  it('keeps the alignment limitation for a series with no completed in-window bucket', async () => {
    const asOf = 1792562161;
    const fetcher = statusFetch(
      {
        events: empty,
        alerts: empty,
        bgp: () => envelope([[bucketed('bgp', 1792562100, [7])]]),
        'ping-slash24': noSeries,
        'merit-nt': noSeries,
      },
      '/v2/signals/raw/country/US',
    );
    const { value } = (await settle(
      service(fetcher).getStatusEvidence({ ...us, asOf }, createMockContext(), budget()),
    )) as { value: StatusEvidence };
    expect(value.limitations).toContain(alignment);
    expect(value.signals[0]?.series[0]).toMatchObject({
      coverage: 'unknown',
      nonNullCount: 0,
      nullCount: 0,
      pendingCount: 0,
    });
  });
  it('routes coarse aggregate buckets to a narrower ioda_get_signals window', async () => {
    const asOf = 1792562100;
    const from = asOf - 3600;
    const coarse = { ...bucketed('bgp', from, [1, 2, 3, 4, 5, 6]), until: from + 3600, step: 600 };
    const fetcher = statusFetch(
      {
        events: empty,
        alerts: empty,
        bgp: () => envelope([[coarse]]),
        'ping-slash24': noSeries,
        'merit-nt': noSeries,
      },
      '/v2/signals/raw/country/US',
    );
    const { value } = (await settle(
      service(fetcher).getStatusEvidence(
        { ...us, lookbackHours: 1, asOf },
        createMockContext(),
        budget(),
      ),
    )) as { value: StatusEvidence };
    expect(value.signals[0]?.series[0]).toMatchObject({ step: 600, nativeStep: 300 });
    expect(value.limitations).toContain(
      'Coarser aggregate buckets cannot establish current coverage; inspect ioda_get_signals over a narrower window.',
    );
  });
});

describe('upstream timeout recovery', () => {
  const findOutagesTimeout =
    'Call ioda_find_outages with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.';
  it.each([
    ['ioda_find_outages', findOutagesTimeout],
    [
      'ioda_get_alerts',
      'Call ioda_get_alerts with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.',
    ],
    [
      'ioda_get_signals',
      'Call ioda_get_signals with a narrower window or retry later after upstream collection timed out.',
    ],
    [
      'ioda_get_status',
      'Call ioda_get_status with a narrower window or retry later after upstream collection timed out.',
    ],
    [
      'ioda_search_entities',
      'Call ioda_search_entities with a smaller limit and page 0, or retry later after upstream collection timed out.',
    ],
    [
      'ioda_summarize_outages',
      'Call ioda_summarize_outages with an entityCode or a relatedToType and relatedToCode scope, a narrower window, or a smaller extendWindowSeconds, or retry later after upstream collection timed out.',
    ],
  ] as const)('routes a %s timeout to the levers that tool takes', (tool, hint) => {
    expect(recoveryFor('upstream_timeout', tool)).toBe(hint);
  });
  it('routes a summary overflow to a smaller limit from page 0', () => {
    expect(recoveryFor('response_too_large', 'ioda_summarize_outages')).toBe(
      'Call ioda_summarize_outages with a smaller limit and page 0, then continue with that fixed limit.',
    );
  });
  it('carries the event levers on a timed-out events exchange and on the status events component', async () => {
    const hanging = statusFetch({ events: () => new Promise<Response>(() => {}) });
    const events = service(hanging).getEvents(
      {
        from: 1000,
        until: 2000,
        page: 0,
        limit: 1,
        includeAlerts: false,
        extendWindowSeconds: 86400,
      },
      createMockContext(),
      budget(),
    );
    const assertion = expect(events).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'upstream_timeout',
        recovery: { hint: findOutagesTimeout },
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(hanging).toHaveBeenCalledOnce();

    const fetcher = statusFetch(
      {
        events: () => new Promise<Response>(() => {}),
        alerts: empty,
        bgp: noSeries,
        'ping-slash24': noSeries,
        'merit-nt': noSeries,
      },
      '/v2/signals/raw/country/US',
    );
    // One exchange at a time: the events attempt holds the queue for its 10 s timeout first.
    const status = service(fetcher).getStatusEvidence(
      { ...statusRequest, entityCode: 'US' },
      createMockContext(),
      budget(),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const value = await status;
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(value.components.map((component) => component.state)).toEqual([
      'failed',
      ...Array(4).fill('ok'),
    ]);
    expect(value.components[0]).toEqual({
      component: 'events',
      state: 'failed',
      failure: {
        code: JsonRpcErrorCode.Timeout,
        reason: 'upstream_timeout',
        message: 'IODA collection timed out.',
        recovery: findOutagesTimeout,
      },
    });
  });
});
