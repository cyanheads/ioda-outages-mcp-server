/**
 * @fileoverview Injected network and shared pacing boundaries.
 * @module tests/services/ioda-service
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IodaService } from '../../src/services/ioda/ioda-service.js';

const input = { entityType: 'country' as const, page: 0, limit: 1 };
const instances: IodaService[] = [];
const envelope = (data: unknown) => Response.json({ error: null, data });
const budget = () => ({ deadline: Date.now() + 45000 });
function service(fetcher: () => Promise<Response>) {
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
  });
  it('throws the first fixed-order error when all status components fail', async () => {
    const pending = service(async () => new Response('missing', { status: 404 })).getStatusEvidence(
      { entityType: 'country', entityCode: 'US', asOf: 1792540800, lookbackHours: 1 },
      createMockContext(),
      budget(),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      data: {
        reason: 'entity_not_found',
        recovery: { hint: expect.stringContaining('ioda_find_outages') },
      },
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
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
