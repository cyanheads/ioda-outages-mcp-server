/**
 * @fileoverview Canonical IODA inputs and exact lossless response budgeting.
 * @module mcp-server/tools/ioda-common
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { type IodaTool, iodaError } from '@/services/ioda/errors.js';
import {
  type EntityReference,
  type EntityType,
  EntityTypeSchema,
  type Pagination,
  type Source,
  SourceSchema,
} from '@/services/ioda/index.js';

/** Transport strings admit the canonicalization promised to callers. */
export const entityInputs = {
  entityType: z.string().describe('country, region, or asn; whitespace and case are normalized.'),
  entityCode: z
    .string()
    .describe(
      'Two-letter country code, IODA numeric region code, or decimal ASN (AS prefix accepted); resolve names with ioda_search_entities and pass a returned code here.',
    ),
};
/** Optional filters explicitly allow global scope. */
export const filterInputs = {
  entityType: entityInputs.entityType.optional(),
  entityCode: entityInputs.entityCode.optional(),
  source: z
    .string()
    .optional()
    .describe(
      'bgp, ping-slash24, merit-nt, or gtr; blank means all sources. Case and whitespace are normalized.',
    ),
};
/** One upstream page with a fixed limit across continuation calls. */
export const pageInputs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Upstream page size; keep fixed when continuing.'),
  page: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Zero-based upstream page; restart at 0 when changing limit.'),
};
/** Historical windows are always explicit. */
export const windowInputs = {
  from: z
    .number()
    .int()
    .positive()
    .describe('Inclusive Unix seconds UTC; no milliseconds; window at most 31 days.'),
  until: z
    .number()
    .int()
    .positive()
    .describe('Exclusive Unix seconds UTC, after from and no later than now.'),
};
/** Required canonical request echo with optional result guidance. */
export const enrichment = {
  applied: z
    .record(z.string(), z.json())
    .describe('Every normalized input, effective window, filter and pagination value.'),
  notice: z.string().optional().describe('Result interpretation and concrete next call.'),
  truncated: z
    .object({
      shown: z.number().int().nonnegative().describe('Returned records'),
      cap: z.number().int().positive().describe('Requested page capacity'),
    })
    .optional()
    .describe('A full page may have further records; not an exact total.'),
};
/** Locally validated enrichment values, disjoint from domain output. */
export type Enrichment = z.infer<z.ZodObject<typeof enrichment>>;

/** Empty optional text is absent before semantic validation. */
export function optionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
/** Validate search length after optional blank normalization. */
export function searchQuery(value: string | undefined): string | undefined {
  const query = optionalText(value);
  if (query && query.length > 200)
    throw invalidParams('query must contain at most 200 characters after trimming.');
  return query;
}
/** Require exactly one supported numeric measurement source. */
export function numericSource(value: string): 'bgp' | 'ping-slash24' | 'merit-nt' {
  const source = sourceFilter(value);
  if (!source || source === 'gtr')
    throw invalidParams('Numeric source must be bgp, ping-slash24, or merit-nt.');
  return source;
}
function invalid(reason: string, message: string, tool: IodaTool): never {
  throw new McpError(JsonRpcErrorCode.ValidationError, message, {
    reason,
    recovery: {
      hint: `Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ${tool} with the selected entityType and a returned code as entityCode.`,
    },
  });
}
/** Canonical entity vocabulary without guessing names or subdivision codes. */
export function entityType(value: string, tool: IodaTool): EntityType {
  const parsed = EntityTypeSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success)
    return invalid('invalid_entity', 'entityType must be country, region, or asn.', tool);
  return parsed.data;
}
/** Canonical entity pair; optional scopes may provide a type without a code. */
export function entityFilter(
  input: { entityType?: string | undefined; entityCode?: string | undefined },
  tool: IodaTool,
): Partial<EntityReference> {
  const rawType = optionalText(input.entityType);
  const rawCode = optionalText(input.entityCode);
  if (!rawType) {
    if (rawCode) invalid('invalid_entity', 'entityCode requires entityType.', tool);
    return {};
  }
  const type = entityType(rawType, tool);
  if (!rawCode) return { entityType: type };
  if (type === 'country') {
    if (!/^[a-z]{2}$/i.test(rawCode))
      invalid(
        'invalid_entity',
        'Country codes require exactly two ASCII letters; resolve names with ioda_search_entities.',
        tool,
      );
    return { entityType: type, entityCode: rawCode.toUpperCase() };
  }
  const digits = type === 'asn' ? rawCode.replace(/^as/i, '') : rawCode;
  if (!/^\d+$/.test(digits))
    invalid('invalid_entity', 'Region and ASN codes require positive decimal digits.', tool);
  const canonical = digits.replace(/^0+/, '') || '0';
  if (
    canonical === '0' ||
    (type === 'asn' && (canonical.length > 10 || Number(canonical) > 4294967295))
  )
    invalid('invalid_entity', 'ASN must be 1–4294967295; region codes must be positive.', tool);
  return { entityType: type, entityCode: canonical };
}
/** Require the complete pair for single-entity workflows. */
export function requiredEntity(
  input: { entityType: string; entityCode: string },
  tool: IodaTool,
): EntityReference {
  const parsed = entityFilter(input, tool);
  if (!parsed.entityType || !parsed.entityCode)
    return invalid('invalid_entity', 'Both entityType and entityCode are required.', tool);
  return { entityType: parsed.entityType, entityCode: parsed.entityCode };
}
/** Normalize documented event/alert source names without source substitution. */
export function sourceFilter(value: string | undefined): Source | undefined {
  const text = optionalText(value)?.toLowerCase();
  if (!text) return undefined;
  const parsed = SourceSchema.safeParse(text);
  if (!parsed.success)
    throw new McpError(
      JsonRpcErrorCode.InvalidParams,
      'source must be bgp, ping-slash24, merit-nt, or gtr.',
    );
  return parsed.data;
}
/** Reject invalid historical intervals using one captured invocation clock. */
export function validateWindow(
  input: { from: number; until: number },
  now: number,
  tool: IodaTool,
): void {
  if (
    input.from >= input.until ||
    input.until > Math.floor(now / 1000) ||
    input.until - input.from > 31 * 86400
  ) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Invalid window: use Unix seconds, not milliseconds; require from < until <= now and at most 31 days.',
      {
        reason: 'invalid_window',
        recovery: {
          hint: `Call ${tool} with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows.`,
        },
      },
    );
  }
}
/** Dynamically fenced JSON cannot promote source text to Markdown structure. */
export function renderJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${text}\n${fence}`;
}
/** A typed endpoint is also a real Markdown link; plain source strings stay data. */
export function renderOutput(value: unknown): { type: 'text'; text: string }[] {
  const endpoints: string[] = [];
  const output = value as {
    provenance?: { endpoint: string };
    components?: { provenance?: { endpoint: string } }[];
  };
  if (output.provenance) endpoints.push(output.provenance.endpoint);
  for (const component of output.components ?? [])
    if (component.provenance) endpoints.push(component.provenance.endpoint);
  const links = endpoints.map(
    (url) =>
      `[IODA endpoint](<${url.replace(/[<>\s\\]/g, (character) => encodeURIComponent(character))}>)`,
  );
  return [
    {
      type: 'text',
      text: `## IODA evidence\n\n${renderJson(value)}${links.length ? `\n\n${links.join('\n')}` : ''}`,
    },
  ];
}
/** The exact render callbacks used by the framework enrichment trailer. */
export const enrichmentTrailer = {
  applied: { render: (value: unknown) => renderJson({ applied: value }) },
  notice: { render: (value: unknown) => renderJson({ notice: value }) },
  truncated: { render: (value: unknown) => renderJson({ truncated: value }) },
};
/** Full pages disclose uncertainty, never an invented total. */
export function pageEnrichment(
  applied: Enrichment['applied'],
  pagination: Pagination,
  notice?: string,
): Enrichment {
  return {
    applied,
    ...(notice && { notice }),
    ...(pagination.more === 'possible' && {
      notice: [
        notice,
        'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.',
      ]
        .filter(Boolean)
        .join(' '),
      truncated: { shown: pagination.returned, cap: pagination.limit },
    }),
  };
}
/** Validate and preflight both final surfaces before publishing any enrichment. */
export function finish<S extends z.ZodObject>(
  schema: S,
  output: z.input<S>,
  values: Enrichment,
  ctx: Context,
  tool: IodaTool,
  deadline: number,
): z.output<S> {
  const domain = schema.parse(output);
  const merged = schema.extend(enrichment).parse({ ...domain, ...values });
  const parsedEnrichment = z.object(enrichment).parse(values);
  const trailer = `\n\n${Object.entries(parsedEnrichment)
    .map(([key, value]) => enrichmentTrailer[key as keyof typeof enrichmentTrailer].render(value))
    .join('\n')}`;
  const encoder = new TextEncoder();
  const bytes =
    encoder.encode(JSON.stringify(merged)).byteLength +
    renderOutput(domain).reduce((sum, block) => sum + encoder.encode(block.text).byteLength, 0) +
    encoder.encode(trailer).byteLength;
  if (bytes > 96 * 1024)
    throw iodaError(
      JsonRpcErrorCode.ValidationError,
      'response_too_large',
      'IODA result exceeded the 96 KiB combined response budget.',
      tool,
    );
  if (ctx.signal.aborted)
    throw iodaError(
      JsonRpcErrorCode.RequestCancelled,
      'request_cancelled',
      'IODA investigation cancelled.',
      tool,
    );
  if (Date.now() >= deadline)
    throw iodaError(
      JsonRpcErrorCode.Timeout,
      'upstream_timeout',
      'IODA invocation deadline expired during assembly.',
      tool,
    );
  ctx.enrich(parsedEnrichment);
  return domain;
}
