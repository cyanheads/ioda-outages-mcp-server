/**
 * @fileoverview ioda_find_outages public IODA tool contract.
 * @module mcp-server/tools/definitions/find-outages.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  EventSchema,
  getIodaService,
  PaginationSchema,
  ProvenanceSchema,
} from '@/services/ioda/index.js';
import {
  clampExtendWindow,
  clampLimit,
  composeEnrichment,
  emptyPageNotice,
  enrichment,
  enrichmentTrailer,
  entityFilter,
  filterInputs,
  finish,
  invocationClock,
  pageInputs,
  relatedScope,
  renderOutput,
  SERVED_CAPS,
  scopeInputs,
  sourceFilter,
  unknownCodeNotice,
  unknownScopeNotice,
  validateWindow,
  windowInputs,
} from '../ioda-common.js';

/**
 * Default extension per scope. IODA's own 14-day default holds once entityType bounds the
 * search; a global search at 14 days outlasts the per-attempt timeout, so it gets one day.
 */
const EXTEND_DEFAULTS = { typed: SERVED_CAPS.extendWindowSeconds, global: 86400 } as const;
/** Disclosed whenever the global default, not the caller, chose the extension. */
const globalDefaultNotice =
  'extendWindowSeconds defaulted to 86400 (one day) for global scope, so events that began more than a day before from can be missing. Add entityType for the 14-day default, or pass extendWindowSeconds explicitly; large global extensions can time out.';
const Output = z.object({
  events: z
    .array(EventSchema)
    .describe('Original outage events and source scores without merging or ranking.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const findOutages = tool('ioda_find_outages', {
  description:
    'Find IODA outage events overlapping an explicit Unix-second window of at most 31 days. Omit entity filters for global scope, which searches one day outside the window by default instead of 14; global searches over multi-day windows can time out, so narrow the window or add entityType. A code requires its entityType. relatedToType and relatedToCode limit results to entityType entities within one country, region, ASN, or geoasn. Source scores are not an absolute severity scale. Starts may precede from; ends can be clipped at until and do not establish recovery. includeAlerts adds nested transitions and can increase size. Pages are zero-based; keep filters and limit fixed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...filterInputs,
    ...scopeInputs,
    ...windowInputs,
    ...pageInputs,
    includeAlerts: z
      .boolean()
      .default(false)
      .describe(
        'Include original nested alert transitions and baselines; may substantially increase response size.',
      ),
    extendWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(SERVED_CAPS.extendWindowSeconds * 10)
      .optional()
      .describe(
        'Seconds before from to search for the start of an event overlapping the window, and after until for its recovery; only overlapping events are returned. Defaults to 1209600 (14 days) with entityType and 86400 (one day) without it, because large global extensions can time out; the applied value is echoed. Values above 1209600 are served as 1209600 with a notice. Zero may miss long-running detections.',
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
      when: 'Invalid entity type, code, or incomplete pair.',
      recovery:
        'Call ioda_search_entities with entityType and query to resolve a country, region, ASN, or geoasn, then call ioda_find_outages with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'relatedToType and relatedToCode are incomplete, unsupported, or malformed, or a scope lacks entityType or comes with entityCode.',
      recovery:
        'Call ioda_find_outages with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_find_outages with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows.',
    },
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'source is not bgp, ping-slash24, merit-nt, or gtr.',
      recovery:
        'Call ioda_find_outages with source bgp, ping-slash24, merit-nt, or gtr, or omit source to search all sources.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_find_outages with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_find_outages with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_find_outages with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_find_outages again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_find_outages again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'IODA does not answer within the per-attempt timeout or the invocation deadline; global searches slow sharply as extendWindowSeconds and the window grow.',
      recovery:
        'Call ioda_find_outages with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA data or bucket metadata does not validate.',
      recovery:
        'Retry ioda_find_outages once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_find_outages with includeAlerts false, a smaller limit and page 0; retrieve transitions with ioda_get_alerts over narrower windows.',
    },
  ],
  async handler(input, ctx) {
    const { now, deadline } = invocationClock();
    validateWindow(input, now);
    const source = sourceFilter(input.source);
    const limit = clampLimit(input.limit, input.page);
    const filter = entityFilter(input);
    const scope = relatedScope(input);
    const globalDefault = input.extendWindowSeconds === undefined && !filter.entityType;
    const extend = clampExtendWindow(
      input.extendWindowSeconds ??
        (filter.entityType ? EXTEND_DEFAULTS.typed : EXTEND_DEFAULTS.global),
      'ioda_find_outages',
      input,
      now,
    );
    const request = {
      ...filter,
      ...scope,
      from: input.from,
      until: input.until,
      ...(source && { source }),
      includeAlerts: input.includeAlerts,
      extendWindowSeconds: extend.value,
      limit: limit.value,
      page: input.page,
    };
    const result = await getIodaService().getEvents(request, ctx, { deadline });
    return finish(
      Output,
      result,
      composeEnrichment(
        {
          ...request,
          scope: scope ? 'related' : request.entityType ? 'entity' : 'global',
          source: source ?? 'all',
          format: 'ioda',
          overall: false,
        },
        [
          limit.notice,
          extend.notice,
          globalDefault && globalDefaultNotice,
          !result.events.length &&
            (input.page > 0
              ? emptyPageNotice('ioda_find_outages')
              : 'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.'),
          !result.events.length && !input.page && request.entityCode && unknownCodeNotice,
          !result.events.length && !input.page && scope && unknownScopeNotice,
        ],
        result.pagination,
      ),
      ctx,
      'ioda_find_outages',
      deadline,
    );
  },
  format: renderOutput,
});
