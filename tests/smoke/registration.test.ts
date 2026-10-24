/**
 * @fileoverview Entrypoint registration without starting a transport or network request.
 * @module tests/smoke/registration
 */
import { z } from '@cyanheads/mcp-ts-core';
import { expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ app: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: capture.app,
}));

it('registers exactly the six read-only IODA tools, identity and lifecycle', async () => {
  await import('../../src/index.js');
  expect(capture.app).toHaveBeenCalledOnce();
  const options = capture.app.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    name: 'ioda-outages-mcp-server',
    title: 'ioda-outages-mcp-server',
    sessionMode: 'stateless',
    resources: [],
    prompts: [],
  });
  expect(options.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'ioda_search_entities',
    'ioda_get_status',
    'ioda_find_outages',
    'ioda_summarize_outages',
    'ioda_get_signals',
    'ioda_get_alerts',
  ]);
  for (const tool of options.tools) {
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tool.input).toBeDefined();
    const schema = z.toJSONSchema(tool.input);
    const properties = schema.properties as Record<string, { pattern?: string }>;
    for (const field of [
      'entityType',
      'entityCode',
      'relatedToType',
      'relatedToCode',
      'source',
      'query',
    ]) {
      if (properties[field])
        expect(properties[field].pattern, `${tool.name}.${field}`).toBeTypeOf('string');
    }
    expect(tool.output).toBeDefined();
    expect(tool.format).toBeTypeOf('function');
  }
  expect(options.setup).toBeTypeOf('function');
  expect(options.teardown).toBeTypeOf('function');
  expect(options.instructions).toContain(
    'Missing alerts or entity metadata never establish healthy',
  );
  expect(options.instructions).toContain("entity's code as entityCode");
  expect(options.instructions).toContain(
    "call ioda_summarize_outages with entityType for IODA's outage-score ranking; its scores are window totals for ranking one request's rows, not current status.",
  );
  expect(options.instructions).toContain(
    'pass entityType with relatedToType and relatedToCode (for example region within country IR) to ioda_search_entities, ioda_find_outages, ioda_summarize_outages, or ioda_get_alerts.',
  );
  expect(options.instructions).toContain('geoasn (one ASN within a region or country)');
});
