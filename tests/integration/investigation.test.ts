/**
 * @fileoverview Entity resolution chained into an outage investigation over fake HTTP.
 * @module tests/integration/investigation
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { findOutages } from '../../src/mcp-server/tools/definitions/find-outages.tool.js';
import { searchEntities } from '../../src/mcp-server/tools/definitions/search-entities.tool.js';
import { disposeIodaService, initIodaService } from '../../src/services/ioda/index.js';

afterEach(() => {
  disposeIodaService();
  vi.useRealTimers();
});

it('uses a returned metadata code with the selected type while preserving unknown measurement coverage', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1792540800000);
  const calls: URL[] = [];
  initIodaService({
    fetch: (async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/v2/entities/query')
        return Response.json({ data: [{ code: 'US', name: 'United States' }] });
      if (url.pathname === '/v2/outages/events') return Response.json({ data: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }) as typeof fetch,
  });
  const resolved = await runToolContract(searchEntities, {
    entityType: 'country',
    query: 'United States',
  });
  expect(resolved.isError).not.toBe(true);
  const found = (resolved.structuredContent as { entities: { code: string; name: string }[] })
    .entities[0];
  expect(found).toEqual({ code: 'US', name: 'United States' });
  const pending = runToolContract(findOutages, {
    entityType: 'country',
    entityCode: found?.code,
    from: 1792537200,
    until: 1792540800,
  });
  await vi.advanceTimersByTimeAsync(2000);
  const evidence = await pending;
  expect(evidence.isError).not.toBe(true);
  expect(evidence.structuredContent).toMatchObject({
    events: [],
    applied: { entityType: 'country', entityCode: 'US' },
    notice: expect.stringContaining('not an all-clear'),
  });
  const text = evidence.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  expect(text).toContain('not an all-clear');
  expect(text).toContain('ioda_get_signals');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.searchParams.get('entityCode')).toBe('US');
  expect(calls[1]?.searchParams.get('entityType')).toBe('country');
});
