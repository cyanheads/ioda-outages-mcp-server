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
  enrichment,
  enrichmentTrailer,
  entityFilter,
  filterInputs,
  finish,
  pageEnrichment,
  pageInputs,
  renderOutput,
  sourceFilter,
  validateWindow,
  windowInputs,
} from '../ioda-common.js';

const Output = z.object({
  events: z
    .array(EventSchema)
    .describe('Original outage events and source scores without merging or ranking.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const findOutages = tool('ioda_find_outages', {
  description:
    'Find IODA outage events overlapping an explicit Unix-second window of at most 31 days. Omit entity filters for global scope; a code requires its entityType. Source scores are not an absolute severity scale. Starts may precede from; ends can be clipped at until and do not establish recovery. includeAlerts adds nested transitions and can increase size. Pages are zero-based; keep filters and limit fixed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...filterInputs,
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
      .max(1209600)
      .default(1209600)
      .describe(
        'Search extension outside the requested window in seconds; zero may miss long-running detections.',
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
        'Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ioda_find_outages with the selected entityType and a returned code as entityCode.',
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
    const now = Date.now();
    const deadline = now + 45000;
    validateWindow(input, now, 'ioda_find_outages');
    const source = sourceFilter(input.source);
    const request = {
      ...entityFilter(input, 'ioda_find_outages'),
      from: input.from,
      until: input.until,
      ...(source && { source }),
      includeAlerts: input.includeAlerts,
      extendWindowSeconds: input.extendWindowSeconds,
      limit: input.limit,
      page: input.page,
    };
    const result = await getIodaService().getEvents(request, ctx, { deadline });
    const notice = !result.events.length
      ? input.page > 0
        ? 'This page is empty. Call ioda_find_outages with page 0 and unchanged filters, or return to the previous page.'
        : 'No detected events were returned for this scope and window. Call ioda_get_signals for measurement coverage, or ioda_find_outages with a wider window or fewer filters. This is not an all-clear.'
      : undefined;
    return finish(
      Output,
      result,
      pageEnrichment(
        {
          ...request,
          scope: request.entityType ? 'entity' : 'global',
          source: source ?? 'all',
          format: 'ioda',
          overall: false,
        },
        result.pagination,
        notice,
      ),
      ctx,
      'ioda_find_outages',
      deadline,
    );
  },
  format: renderOutput,
});
