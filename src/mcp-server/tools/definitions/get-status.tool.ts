/**
 * @fileoverview ioda_get_status public IODA tool contract.
 * @module mcp-server/tools/definitions/get-status.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getIodaService, StatusEvidenceSchema } from '@/services/ioda/index.js';
import {
  enrichment,
  enrichmentTrailer,
  entityInputs,
  finish,
  renderOutput,
  requiredEntity,
} from '../ioda-common.js';
export const getStatus = tool('ioda_get_status', {
  description:
    'Inspect recent IODA detection evidence and measurement coverage for one entity over a lookback of 1–24 hours. Collect events, alerts, bgp, ping-slash24 and merit-nt evidence. Partial failures remain explicit and route to standalone tools. recent, stale, no_data and unknown describe observation availability; no alerts is not an all-clear. IODA measures macroscopic connectivity, not one office or a shutdown cause.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...entityInputs,
    lookbackHours: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(6)
      .describe('Hours before the captured invocation time; exact window is returned.'),
  }),
  output: StatusEvidenceSchema,
  enrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_entity',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Invalid entity type, code, or incomplete pair.',
      recovery:
        'Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ioda_get_status with the selected entityType and a returned code as entityCode.',
    },

    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_get_status with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_get_status with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_get_status with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_get_status again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_get_status again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA data or bucket metadata does not validate.',
      recovery:
        'Retry ioda_get_status once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_get_status with a shorter lookbackHours, or call ioda_find_outages, ioda_get_alerts, and ioda_get_signals separately with narrower windows.',
    },
  ],
  async handler(input, ctx) {
    const now = Date.now();
    const deadline = now + 45000;
    const asOf = Math.floor(now / 1000);
    const request = {
      ...requiredEntity(input, 'ioda_get_status'),
      asOf,
      lookbackHours: input.lookbackHours,
    };
    const result = await getIodaService().getStatusEvidence(request, ctx, { deadline });
    const applied = {
      ...request,
      from: asOf - input.lookbackHours * 3600,
      until: asOf,
      events: {
        limit: 20,
        page: 0,
        includeAlerts: false,
        extendWindowSeconds: 1209600,
        format: 'ioda',
        overall: false,
      },
      alerts: { limit: 100, page: 0, extendWindowSeconds: 0 },
      signals: { sources: ['bgp', 'ping-slash24', 'merit-nt'], maxPoints: 2000 },
    };
    return finish(
      StatusEvidenceSchema,
      result,
      {
        applied,
        ...(result.components.some((item) => item.state === 'failed') && {
          notice:
            'Evidence is incomplete. Follow each failed component recovery with its standalone tool; missing evidence does not establish healthy connectivity.',
        }),
      },
      ctx,
      'ioda_get_status',
      deadline,
    );
  },
  format: renderOutput,
});
