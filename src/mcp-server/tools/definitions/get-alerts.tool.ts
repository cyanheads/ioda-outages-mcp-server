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
  alerts: z
    .array(AlertSchema)
    .describe('Literal detection and recovery transitions with source baselines.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const getAlerts = tool('ioda_get_alerts', {
  description:
    'Retrieve IODA detection and recovery transitions in an explicit Unix-second window of at most 31 days. Omit entity filters for global scope; a code requires entityType. Each transition retains its source, level, condition, value and baseline; levels and baselines are not a source-independent severity scale. Missing transitions do not establish health. Pages are zero-based; keep filters and limit fixed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...filterInputs,
    ...windowInputs,
    ...pageInputs,
    extendWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(1209600)
      .default(0)
      .describe('Search extension in seconds; zero means no extension by default.'),
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
        'Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ioda_get_alerts with the selected entityType and a returned code as entityCode.',
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
    const now = Date.now();
    const deadline = now + 45000;
    validateWindow(input, now, 'ioda_get_alerts');
    const source = sourceFilter(input.source);
    const request = {
      ...entityFilter(input, 'ioda_get_alerts'),
      from: input.from,
      until: input.until,
      ...(source && { source }),
      extendWindowSeconds: input.extendWindowSeconds,
      limit: input.limit,
      page: input.page,
    };
    const result = await getIodaService().getAlerts(request, ctx, { deadline });
    const notice = !result.alerts.length
      ? input.page > 0
        ? 'This page is empty. Call ioda_get_alerts with page 0 and unchanged filters, or return to the previous page.'
        : 'No alert transitions were returned. An event may have started earlier. Call ioda_find_outages over this window for overlapping events, or ioda_get_signals for observations.'
      : undefined;
    return finish(
      Output,
      result,
      pageEnrichment(
        { ...request, scope: request.entityType ? 'entity' : 'global', source: source ?? 'all' },
        result.pagination,
        notice,
      ),
      ctx,
      'ioda_get_alerts',
      deadline,
    );
  },
  format: renderOutput,
});
