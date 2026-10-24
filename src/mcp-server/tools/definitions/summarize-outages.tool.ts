/**
 * @fileoverview ioda_summarize_outages public IODA tool contract.
 * @module mcp-server/tools/definitions/summarize-outages.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getIodaService,
  PaginationSchema,
  ProvenanceSchema,
  SummarySchema,
} from '@/services/ioda/index.js';
import {
  clampExtendWindow,
  clampLimit,
  composeEnrichment,
  emptyPageNotice,
  enrichment,
  enrichmentTrailer,
  entityFilter,
  entityInputs,
  entityType,
  filterInputs,
  finish,
  ignoredMethods,
  ignoreMethodsInput,
  invocationClock,
  pageInputs,
  relatedMembershipNotice,
  relatedScope,
  renderOutput,
  SERVED_CAPS,
  scopeInputs,
  unknownCodeNotice,
  unknownScopeNotice,
  validateWindow,
  windowInputs,
} from '../ioda-common.js';

const Output = z.object({
  summaries: z
    .array(SummarySchema)
    .describe("IODA's per-entity summaries in its own order, descending scores.overall."),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const summarizeOutages = tool('ioda_summarize_outages', {
  description:
    "Rank the entities of one entityType by IODA's outage summary score over an explicit Unix-second window of at most 31 days, such as the countries or a country's regions hit hardest this week. Rows keep IODA's order, descending scores.overall. IODA merges overlapping events from different sources, scores each merged event as the product of its sources' scores, and sums the merged events into overall; each <source>.<method> key sums that source's event scores. Scores are window totals for ranking the rows of one request, not current status, and are not comparable across requests with different windows. Add entityCode for one entity, or relatedToType and relatedToCode to rank entityType entities within one country, region, ASN, or geoasn; large type-only rankings can time out. Event-start selection includes until, so adjacent windows can duplicate boundary detections. ignoreMethods excludes source.method, source.*, or *.method upstream before scoring; keep exclusions fixed when comparing rankings or drilling into events and alerts. An empty result is not an all-clear. Pages are zero-based; keep filters and limit fixed.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    entityType: entityInputs.entityType,
    entityCode: filterInputs.entityCode,
    ...scopeInputs,
    ...windowInputs,
    ...pageInputs,
    ignoreMethods: ignoreMethodsInput,
    extendWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(SERVED_CAPS.extendWindowSeconds * 10)
      .default(SERVED_CAPS.extendWindowSeconds)
      .describe(
        "Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; defaults to 1209600 (14 days), IODA's default. Values above 1209600 are served as 1209600 with a notice. Large extensions on type-only rankings can time out; zero may miss long-running detections.",
      ),
  }),
  output: Output,
  enrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_entity',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'entityCode is incompatible with entityType, zero or out of range.',
      recovery:
        'Call ioda_summarize_outages with entityType country, region, asn, or geoasn; to score one entity, resolve it with ioda_search_entities and pass a returned code as entityCode.',
    },
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'relatedToType and relatedToCode are incomplete or incompatible, the code is zero or out of range, or a scope comes with entityCode.',
      recovery:
        'Call ioda_summarize_outages with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_summarize_outages with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows; shared boundaries can duplicate detections.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_summarize_outages with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_summarize_outages with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_summarize_outages with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_summarize_outages again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_summarize_outages again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'IODA does not answer within the per-attempt timeout or the invocation deadline; type-only rankings such as every region are the slowest, and slow further as extendWindowSeconds and the window grow.',
      recovery:
        'Call ioda_summarize_outages with an entityCode or a relatedToType and relatedToCode scope, a narrower window, or a smaller extendWindowSeconds, or retry later after upstream collection timed out.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA summary rows lack an entity, a numeric scores.overall, or an integer event_cnt, or carry a non-numeric score.',
      recovery:
        'Retry ioda_summarize_outages once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_summarize_outages with a smaller limit and page 0, then continue with that fixed limit.',
    },
  ],
  async handler(input, ctx) {
    const { now, deadline } = invocationClock();
    validateWindow(input, now);
    const ignoreMethods = ignoredMethods(input.ignoreMethods);
    const filter = entityFilter(input);
    // entityType is required here, so a blank one is an invalid type before any scope check.
    const type = entityType(input.entityType);
    const scope = relatedScope(input);
    const limit = clampLimit(input.limit, input.page);
    const extend = clampExtendWindow(
      input.extendWindowSeconds,
      'ioda_summarize_outages',
      input,
      now,
    );
    const request = {
      entityType: type,
      ...(filter.entityCode && { entityCode: filter.entityCode }),
      ...scope,
      from: input.from,
      until: input.until,
      ...(ignoreMethods && { ignoreMethods }),
      extendWindowSeconds: extend.value,
      limit: limit.value,
      page: input.page,
    };
    const result = await getIodaService().getSummary(request, ctx, { deadline });
    return finish(
      Output,
      result,
      composeEnrichment(
        {
          ...request,
          scope: scope ? 'related' : 'entity',
          order: 'scores.overall descending',
        },
        [
          limit.notice,
          extend.notice,
          relatedMembershipNotice('ioda_summarize_outages', request),
          !result.summaries.length &&
            (input.page > 0
              ? emptyPageNotice('ioda_summarize_outages')
              : 'No outage summaries were returned for this scope and window. Call ioda_find_outages for detected events or ioda_get_signals for measurement coverage, or ioda_summarize_outages with a wider window or fewer filters. This is not an all-clear.'),
          !result.summaries.length && !input.page && request.entityCode && unknownCodeNotice,
          !result.summaries.length && !input.page && scope && unknownScopeNotice,
        ],
        result.pagination,
      ),
      ctx,
      'ioda_summarize_outages',
      deadline,
    );
  },
  format: renderOutput,
});
