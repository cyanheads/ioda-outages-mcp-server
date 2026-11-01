/**
 * @fileoverview Sanitized IODA service errors and standalone recovery routes.
 * @module services/ioda/errors
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** A literal calling tool, never caller-supplied text. */
export type IodaTool =
  | 'ioda_search_entities'
  | 'ioda_find_outages'
  | 'ioda_summarize_outages'
  | 'ioda_get_alerts'
  | 'ioda_get_signals'
  | 'ioda_get_status';
/** Declared service failure surface. */
export type IodaReason =
  | 'upstream_bad_request'
  | 'upstream_unprocessable'
  | 'entity_not_found'
  | 'upstream_rate_limited'
  | 'upstream_queue_full'
  | 'upstream_schema'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_unauthorized'
  | 'upstream_forbidden'
  | 'request_cancelled';
/** Recovery text suitable for failure data or partial-status records. */
export function recoveryFor(reason: IodaReason, tool: IodaTool): string {
  switch (reason) {
    case 'upstream_bad_request':
    case 'upstream_unprocessable':
      if (tool === 'ioda_search_entities')
        return 'Call ioda_search_entities with a supported entityType and either query or entityCode; use a shorter query or omit it to list that type.';
      return `Call ${tool} with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.`;
    case 'entity_not_found':
      return `Call ioda_search_entities with entityType and the name as query, then retry ${tool} with the selected entityType and a returned code as entityCode.`;
    case 'upstream_rate_limited':
      return `Call ${tool} again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.`;
    case 'upstream_queue_full':
      return `Call ${tool} again later; avoid concurrent investigations while the shared upstream queue is full.`;
    case 'upstream_schema':
      if (tool === 'ioda_search_entities')
        return 'Retry ioda_search_entities once with a smaller limit and page 0; if the response still cannot be parsed, stop this search and report the response schema failure.';
      return `Retry ${tool} once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.`;
    case 'upstream_unauthorized':
    case 'upstream_forbidden':
      return `The keyless public endpoint refused access. Retry ${tool} later; no API key is required.`;
    case 'upstream_timeout':
      if (tool === 'ioda_search_entities')
        return 'Call ioda_search_entities with a smaller limit and page 0, or retry later after upstream collection timed out.';
      if (tool === 'ioda_find_outages' || tool === 'ioda_get_alerts')
        return `Call ${tool} with a narrower window, a smaller extendWindowSeconds, or an entityType filter, or retry later after upstream collection timed out.`;
      if (tool === 'ioda_summarize_outages')
        return 'Call ioda_summarize_outages with an entityCode or a relatedToType and relatedToCode scope, a narrower window, or a smaller extendWindowSeconds, or retry later after upstream collection timed out.';
      return `Call ${tool} with a narrower window or retry later after upstream collection timed out.`;
    case 'request_cancelled':
      return `Call ${tool} again only if the investigation is still needed.`;
    case 'upstream_unavailable':
      return `Retry ${tool} later after the public upstream service recovers.`;
  }
}
/** Build an error containing allowlisted service data only. */
export function iodaError(
  code: JsonRpcErrorCode,
  reason: IodaReason,
  message: string,
  tool: IodaTool,
  extra: { retryAfter?: string | number; recovery?: string; status?: number } = {},
): McpError {
  return new McpError(code, message, {
    reason,
    recovery: { hint: extra.recovery ?? recoveryFor(reason, tool) },
    ...(extra.retryAfter !== undefined && { retryAfter: extra.retryAfter }),
    ...(extra.status !== undefined && { status: extra.status }),
  });
}
/** Caller cancellation, distinct from deadline and upstream timeouts. */
export function cancelledError(tool: IodaTool): McpError {
  return iodaError(
    JsonRpcErrorCode.RequestCancelled,
    'request_cancelled',
    'IODA investigation cancelled.',
    tool,
  );
}
