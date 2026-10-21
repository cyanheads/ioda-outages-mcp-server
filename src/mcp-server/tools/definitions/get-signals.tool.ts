/**
 * @fileoverview ioda_get_signals public IODA tool contract.
 * @module mcp-server/tools/definitions/get-signals.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getIodaService,
  NumericSeriesSchema,
  NumericSourceSchema,
  ProvenanceSchema,
} from '@/services/ioda/index.js';
import {
  enrichment,
  enrichmentTrailer,
  entityInputs,
  finish,
  numericSource,
  renderOutput,
  requiredEntity,
  validateWindow,
  windowInputs,
} from '../ioda-common.js';

const Output = z.object({
  series: z
    .array(NumericSeriesSchema)
    .describe('All numeric subtypes and buckets, preserving nulls and aligned bounds.'),
  semantics: z
    .object({
      source: NumericSourceSchema.describe('Requested numeric source.'),
      measurement: z.string().describe('What this source measures.'),
      caveat: z.string().describe('Limits on interpretation.'),
    })
    .describe('Source-specific measurement semantics.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
const semantics = {
  bgp: {
    measurement: 'BGP routing visibility',
    caveat: "Visibility from IODA's routing vantage points is not end-user reachability.",
  },
  'ping-slash24': {
    measurement: 'Active IPv4 /24 probing reachability',
    caveat: 'Responses from probed networks are not universal access measurements.',
  },
  'merit-nt': {
    measurement: 'Unsolicited traffic observed by the Merit network telescope',
    caveat:
      'Traffic volume depends on telescope visibility and traffic behavior, not connectivity alone.',
  },
};
export const getSignals = tool('ioda_get_signals', {
  description:
    'Fetch numeric BGP visibility, active IPv4 /24 probing, or Merit telescope series for one entity in an explicit Unix-second window of at most 31 days. source is required: bgp, ping-slash24, or merit-nt. Nulls are missing observations, not zero connectivity. maxPoints requests upstream aggregation, not first-N samples; smaller values lose temporal resolution. Returned series retain aligned boundary buckets; timestamps and intervals support cross-source comparisons.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...entityInputs,
    ...windowInputs,
    source: z
      .string()
      .describe(
        'Exactly bgp, ping-slash24, or merit-nt; case and whitespace normalized. gtr and ucsd-nt are not supported numeric sources.',
      ),
    maxPoints: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(200)
      .describe(
        'Upstream aggregation target, not a local sample cap; smaller targets lose temporal resolution.',
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
        'Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ioda_get_signals with the selected entityType and a returned code as entityCode.',
    },

    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_get_signals with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_get_signals with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_get_signals with a narrower window and supported filters; use ioda_search_entities to verify the entity code before retrying.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_get_signals with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_get_signals again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_get_signals again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA data or bucket metadata does not validate.',
      recovery:
        'Retry ioda_get_signals once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_get_signals with fewer maxPoints or split the time window into adjacent requests.',
    },
  ],
  async handler(input, ctx) {
    const now = Date.now();
    const deadline = now + 45000;
    validateWindow(input, now, 'ioda_get_signals');
    const source = numericSource(input.source);
    const request = {
      ...requiredEntity(input, 'ioda_get_signals'),
      source,
      from: input.from,
      until: input.until,
      maxPoints: input.maxPoints,
    };
    const result = await getIodaService().getNumericSignals(request, ctx, { deadline });
    return finish(
      Output,
      { ...result, semantics: { source, ...semantics[source] } },
      {
        applied: request,
        ...(!result.series.length && {
          notice:
            'No observations were returned. Call ioda_search_entities to verify the code, or ioda_get_signals with another core source or an earlier window. Missing data does not establish healthy connectivity.',
        }),
      },
      ctx,
      'ioda_get_signals',
      deadline,
    );
  },
  format: renderOutput,
});
