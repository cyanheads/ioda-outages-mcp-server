/**
 * @fileoverview ioda_get_alerts public IODA tool contract.
 * @module mcp-server/tools/definitions/get-alerts.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AlertSchema,
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

/** IODA cannot continue a scoped alert request past page 0. */
const scopedRoute =
  'Call ioda_get_alerts with page 0 and a narrower window, or list the scope entities with ioda_search_entities (same entityType and scope) and call ioda_get_alerts per entityCode.';
const Output = z.object({
  alerts: z
    .array(AlertSchema)
    .describe('Literal detection and recovery transitions with source baselines.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const getAlerts = tool('ioda_get_alerts', {
  description:
    'Retrieve IODA detection and recovery transitions in an explicit Unix-second window of at most 31 days. Omit entity filters for global scope; a code requires entityType. relatedToType and relatedToCode limit results to entityType entities within one country, region, ASN, or geoasn, served at page 0 only. Each transition retains its source, level, condition, value and baseline; levels and baselines are not a source-independent severity scale. Missing transitions do not establish health. Pages are zero-based; keep filters and limit fixed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...filterInputs,
    ...scopeInputs,
    ...windowInputs,
    ...pageInputs,
    extendWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(SERVED_CAPS.extendWindowSeconds * 10)
      .default(0)
      .describe(
        'Seconds before from and after until to also return transitions from; zero, the default, returns only transitions inside the window. Without entityType, large extensions are slow globally and can time out, so add entityType or keep the extension small. Values above 1209600 (14 days) are served as 1209600 with a notice.',
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
        'Call ioda_search_entities with entityType and query to resolve a country, region, ASN, or geoasn, then call ioda_get_alerts with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'relatedToType and relatedToCode are incomplete, unsupported, or malformed, a scope lacks entityType or comes with entityCode, or a scope asks for a page above 0.',
      recovery:
        'Call ioda_get_alerts at page 0 with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_get_alerts with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows.',
    },
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'source is not bgp, ping-slash24, merit-nt, or gtr.',
      recovery:
        'Call ioda_get_alerts with source bgp, ping-slash24, merit-nt, or gtr, or omit source to search all sources.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_get_alerts with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_get_alerts with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_get_alerts with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_get_alerts again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_get_alerts again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'IODA does not answer within the per-attempt timeout or the invocation deadline; global searches slow sharply as extendWindowSeconds and the window grow.',
      recovery:
        'Call ioda_get_alerts with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA data or bucket metadata does not validate.',
      recovery:
        'Retry ioda_get_alerts once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_get_alerts with a narrower window or smaller limit and page 0, then continue with that fixed limit.',
    },
  ],
  async handler(input, ctx) {
    const { now, deadline } = invocationClock();
    validateWindow(input, now);
    const source = sourceFilter(input.source);
    const limit = clampLimit(input.limit, input.page);
    const extend = clampExtendWindow(input.extendWindowSeconds, 'ioda_get_alerts', input, now);
    const filter = entityFilter(input);
    const scope = relatedScope(input);
    if (scope && input.page > 0)
      throw ctx.fail(
        'invalid_scope',
        'A relatedTo scope is served at page 0 only; IODA cannot continue scoped alerts.',
        { recovery: { hint: scopedRoute } },
      );
    const request = {
      ...filter,
      ...scope,
      from: input.from,
      until: input.until,
      ...(source && { source }),
      extendWindowSeconds: extend.value,
      limit: limit.value,
      page: input.page,
    };
    const result = await getIodaService().getAlerts(request, ctx, { deadline });
    return finish(
      Output,
      result,
      composeEnrichment(
        {
          ...request,
          scope: scope ? 'related' : request.entityType ? 'entity' : 'global',
          source: source ?? 'all',
        },
        [
          limit.notice,
          extend.notice,
          !result.alerts.length &&
            (input.page > 0
              ? emptyPageNotice('ioda_get_alerts')
              : 'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.'),
          !result.alerts.length && !input.page && request.entityCode && unknownCodeNotice,
          !result.alerts.length && scope && unknownScopeNotice,
          scope &&
            result.pagination.more === 'possible' &&
            `This scoped page is full and IODA cannot continue scoped alerts past page 0, so more transitions may exist. ${scopedRoute}`,
        ],
        result.pagination,
      ),
      ctx,
      'ioda_get_alerts',
      deadline,
    );
  },
  format: renderOutput,
});
