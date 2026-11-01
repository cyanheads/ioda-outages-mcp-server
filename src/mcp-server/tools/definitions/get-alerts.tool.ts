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
  archiveNotice,
  archivePosition,
  cappedInput,
  cappedMeta,
  clampExtendWindow,
  clampLimit,
  composeEnrichment,
  emptyPageNotice,
  enrichment,
  enrichmentTrailer,
  entityFilter,
  filterInputs,
  finish,
  ignoredMethods,
  ignoreMethodsInput,
  invocationClock,
  pageInputs,
  placeholderRegionNotice,
  relatedMembershipNotice,
  relatedScope,
  renderOutput,
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
    "Retrieve IODA detection and recovery transitions in an explicit Unix-second window of at most 31 days. Omit entity filters for global scope; a code requires entityType. relatedToType and relatedToCode limit results to entityType entities within one country, region, ASN, or geoasn, served at page 0 only. Each transition retains its source, level, condition, value and baseline; levels and baselines are not a source-independent severity scale. A recovery's historyValue can be a baseline IODA re-based during a long event; compare its value with the detection's historyValue and condition. Transitions include both requested bounds, widened by extendWindowSeconds; adjacent windows can duplicate boundary detections. ignoreMethods excludes source.method, source.*, or *.method upstream. Missing transitions do not establish health. Pages are zero-based; keep filters and limit fixed.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...filterInputs,
    ...scopeInputs,
    ...windowInputs,
    ...pageInputs,
    ignoreMethods: ignoreMethodsInput,
    extendWindowSeconds: cappedInput('extendWindowSeconds', 0)
      .default(0)
      .meta(
        cappedMeta(
          'extendWindowSeconds',
          (clamped, cap) =>
            `Seconds before from and after until to also return transitions from; zero, the default, returns only transitions inside the window. Without entityType, large extensions are slow globally and can time out, so add entityType or keep the extension small. ${clamped ? `Values above ${cap} (14 days) are served as ${cap} with a notice.` : `At most ${cap} (14 days).`}`,
        ),
      ),
  }),
  output: Output,
  enrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_ignore_methods',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An explicit source is also excluded by its own source.* entry.',
      recovery:
        'Call ioda_get_alerts after removing the conflicting source.* entry from ignoreMethods or omitting source; keep the other filters unchanged.',
    },
    {
      reason: 'invalid_entity',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'entityCode is incompatible with entityType, zero or out of range, or supplied without entityType.',
      recovery:
        'Call ioda_search_entities with entityType and query to resolve a country, region, ASN, or geoasn, then call ioda_get_alerts with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'relatedToType and relatedToCode are incomplete or incompatible, the code is zero or out of range, a scope lacks entityType or comes with entityCode, or a scope asks for a page above 0.',
      recovery:
        'Call ioda_get_alerts at page 0 with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields; resolve the scope code with ioda_search_entities.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_get_alerts with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows; shared boundaries can duplicate detections.',
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
      when: 'IODA data or bucket metadata does not validate, or the response body is over 4 MiB.',
      recovery:
        'Retry ioda_get_alerts once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
  ],
  async handler(input, ctx) {
    const { now, deadline } = invocationClock();
    validateWindow(input, now);
    const source = sourceFilter(input.source);
    const ignoreMethods = ignoredMethods(input.ignoreMethods, source);
    const limit = clampLimit(input.limit, input.page, ctx, 'ioda_get_alerts');
    const extend = clampExtendWindow(input.extendWindowSeconds, 'ioda_get_alerts', input, now, ctx);
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
      ...(ignoreMethods && { ignoreMethods }),
      ...(source && { source }),
      extendWindowSeconds: extend.value,
      limit: limit.value,
      page: input.page,
    };
    const result = await getIodaService().getAlerts(request, ctx, { deadline });
    const empty = !result.alerts.length;
    // Alerts are selected from from − extension through until + extension.
    const archive =
      empty && !input.page
        ? archivePosition(
            { from: input.from - extend.value, until: input.until + extend.value },
            'detections',
          )
        : undefined;
    const ordinary = archive === 'straddles' || archive === 'after';
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
          relatedMembershipNotice('ioda_get_alerts', request),
          placeholderRegionNotice(result.alerts.map((alert) => alert.entity)),
          empty && input.page > 0 && emptyPageNotice('ioda_get_alerts'),
          archive === 'before' && archiveNotice('detections', 'before'),
          ordinary &&
            'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.',
          ordinary && request.entityCode && unknownCodeNotice,
          ordinary && scope && unknownScopeNotice,
          archive === 'straddles' && archiveNotice('detections', 'straddles'),
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
