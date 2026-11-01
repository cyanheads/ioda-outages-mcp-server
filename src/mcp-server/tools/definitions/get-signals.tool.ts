/**
 * @fileoverview ioda_get_signals public IODA tool contract.
 * @module mcp-server/tools/definitions/get-signals.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getIodaService,
  type NumericSeries,
  NumericSeriesSchema,
  ProvenanceSchema,
  PUBLICATION_ALLOWANCE_SECONDS,
  SIGNAL_UNITS,
  type SignalRequest,
  type SignalSource,
  SignalSourceSchema,
  SignalUnitSchema,
} from '@/services/ioda/index.js';
import {
  archiveNotice,
  archivePosition,
  asnPlaceholderNotice,
  cappedInput,
  cappedMeta,
  clampMaxPoints,
  composeEnrichment,
  enrichment,
  enrichmentTrailer,
  entityInputs,
  finish,
  invocationClock,
  renderOutput,
  requiredEntity,
  signalSource,
  signalSourceInput,
  signalWindowInputs,
  validateWindow,
} from '../ioda-common.js';

const Output = z.object({
  series: z
    .array(NumericSeriesSchema)
    .describe('All numeric subtypes and buckets, preserving nulls and aligned bounds.'),
  semantics: z
    .object({
      source: SignalSourceSchema.describe('Requested numeric source.'),
      measurement: z.string().describe('What this source measures.'),
      unit: SignalUnitSchema,
      caveat: z.string().describe('Limits on interpretation.'),
    })
    .describe('Source-specific measurement semantics and IODA unit.'),
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
  gtr: {
    measurement: 'Google product traffic from the Google Transparency Report',
    caveat:
      "Compare a country with its own history, not with other countries. A gtr alert's value is the bucket starting at its time divided by 1,000,000 and truncated; its historyValue is a forecast baseline on that scale that this series does not carry.",
  },
} satisfies Record<SignalSource, { measurement: string; caveat: string }>;
const missingData = 'Missing data does not establish healthy connectivity.';
/**
 * How long after a bucket ends IODA may still publish it. bgp and ping-slash24 share
 * ioda_get_status's allowance. merit-nt and gtr publish in batches: in reads on 2026-11-01
 * merit-nt's newest bucket was 620 s, 3,056 s, and over 7,200 s old within ten minutes, and gtr's
 * 3,957–5,757 s, so both take an allowance above every lag measured.
 */
const PUBLICATION_ALLOWANCES = {
  bgp: PUBLICATION_ALLOWANCE_SECONDS,
  'ping-slash24': PUBLICATION_ALLOWANCE_SECONDS,
  'merit-nt': 10800,
  gtr: 10800,
} as const satisfies Record<SignalSource, number>;
/**
 * Guidance for a call that returned no series; the first matching case wins. IODA serves gtr for
 * countries only and gives it no archive start. A core-source window ending by its archive start
 * holds nothing, so verify-code and earlier-window advice would only reach further into the gap;
 * a window straddling the start keeps the usual advice without the earlier window. Every bucket
 * of a window starting within the publication allowance ends inside it, so lag alone explains an
 * empty result there. An ASN's search row never confirms data, so its advice skips verification.
 */
function emptySeriesNotice(request: SignalRequest, asOf: number): string {
  const { entityType, source } = request;
  if (source === 'gtr' && entityType !== 'country')
    return 'IODA serves gtr for countries only. Call ioda_get_signals with source bgp, ping-slash24, or merit-nt for this entity, or with entityType country and a country code for gtr.';
  const archive =
    source === 'gtr' ? undefined : { source, position: archivePosition(request, source) };
  if (archive?.position === 'before')
    return `${archiveNotice(archive.source, 'before')} ${missingData}`;
  const allowance = PUBLICATION_ALLOWANCES[source];
  if (request.from >= asOf - allowance)
    return `No observations were returned. This window starts at most ${allowance} seconds before the call, inside the publication allowance, so IODA may not have published any of its ${source} buckets yet. Call ioda_get_signals with a window ending at least ${allowance} seconds before the call. ${missingData}`;
  const straddles = archive?.position === 'straddles' ? archive.source : undefined;
  const sources = `${source === 'gtr' ? 'a' : 'another'} core source${straddles ? '' : ' or an earlier window'}`;
  const advice =
    entityType === 'asn'
      ? `${asnPlaceholderNotice} Call ioda_get_signals with ${sources}.`
      : `Call ioda_search_entities to verify the code, or ioda_get_signals with ${sources}.`;
  return `No observations were returned. ${advice} ${missingData}${straddles ? ` ${archiveNotice(straddles, 'straddles')}` : ''}`;
}
/**
 * Classify the null buckets after a series' last non-null value by bucket end against the
 * invocation time: not yet ended, pending (ended within the allowance, inclusive), or missing.
 * A coarse last observation inside the allowance can aggregate only the samples published so far.
 */
function trailingNulls(series: NumericSeries, asOf: number, allowance: number) {
  const last = series.values.findLastIndex((value) => value !== null);
  const end = (index: number) => series.from + (index + 1) * series.step;
  const tail = { notEnded: 0, pending: 0, missing: 0 };
  for (let index = last + 1; index < series.values.length; index++) {
    const age = asOf - end(index);
    if (age < 0) tail.notEnded++;
    else if (age <= allowance) tail.pending++;
    else tail.missing++;
  }
  const partial = last >= 0 && series.step > series.nativeStep && asOf - end(last) <= allowance;
  return { ...tail, partial };
}
/**
 * Guidance when a returned series ends in buckets IODA may not have published yet. Interior nulls
 * stay missing observations, and a tail that ended before the allowance adds nothing on its own.
 * Returned buckets align past `until`, so the advised window end clears the allowance by one more
 * bucket: ending there, the last bucket can be neither pending nor a partial coarse bucket.
 */
function trailingNullNotice(
  series: readonly NumericSeries[],
  source: SignalSource,
  asOf: number,
): string | undefined {
  const allowance = PUBLICATION_ALLOWANCES[source];
  const step = Math.max(...series.map((item) => item.step));
  const tails = series.map((item, index) => ({
    label: `series[${index}]${item.subtype ? ` (subtype ${item.subtype})` : ''}`,
    ...trailingNulls(item, asOf, allowance),
  }));
  const unpublished = tails.some((tail) => tail.notEnded + tail.pending > 0);
  if (!unpublished && !tails.some((tail) => tail.partial)) return;
  const counted = tails.filter((tail) => tail.notEnded + tail.pending + tail.missing > 0);
  return [
    counted.length > 0 &&
      `Trailing nulls after the last observation: ${counted.map((tail) => `${tail.label} has ${tail.notEnded} not yet ended, ${tail.pending} pending, and ${tail.missing} missing`).join('; ')}.`,
    unpublished &&
      `Not yet ended and pending buckets (ended within the ${allowance}-second publication allowance before the call) are usually unpublished rather than missing observations.`,
    ...tails
      .filter((tail) => tail.partial)
      .map(
        (tail) =>
          `The last non-null value of ${tail.label} is a coarse bucket that has not ended or ended within the ${allowance}-second allowance, so it can aggregate only the samples published so far.`,
      ),
    `To read published buckets, end the window at least ${allowance + step} seconds before the call (the allowance plus one ${step}-second bucket, because the last returned bucket can end after until).`,
  ]
    .filter(Boolean)
    .join(' ');
}
export const getSignals = tool('ioda_get_signals', {
  description: `Fetch numeric BGP visibility, active IPv4 /24 probing, Merit telescope, or Google Transparency Report traffic series for one entity in an explicit Unix-second window of at most 31 days. source is required: bgp, ping-slash24, merit-nt, or gtr (countries only). Nulls are not zero connectivity: trailing nulls in buckets not yet ended or ended within the publication allowance before the call (${PUBLICATION_ALLOWANCES.bgp} seconds for bgp and ping-slash24, ${PUBLICATION_ALLOWANCES.gtr} for merit-nt and gtr) are usually unpublished, and every other null is a missing observation; the notice counts each trailing class. maxPoints requests upstream aggregation, not first-N samples; smaller values lose temporal resolution. Returned series retain aligned boundary buckets with exclusive returned until bounds that may extend beyond requested bounds; timestamps and intervals support cross-source comparisons.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...entityInputs,
    ...signalWindowInputs,
    source: signalSourceInput,
    maxPoints: cappedInput('maxPoints', 1)
      .default(200)
      .meta(
        cappedMeta(
          'maxPoints',
          (clamped, cap) =>
            `Upstream aggregation target, not a local sample cap; smaller targets lose temporal resolution. ${clamped ? `Default 200; a value above ${cap} is served as ${cap} and says so.` : `Default 200, at most ${cap}.`}`,
        ),
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
        'Call ioda_search_entities with entityType and query to resolve a country, region, ASN, or geoasn, then call ioda_get_signals with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reversed, future, millisecond, or over-31-day window.',
      recovery:
        'Call ioda_get_signals with integer Unix seconds from < until <= now and a window no longer than 31 days; split longer investigations into adjacent windows; aligned boundary buckets can repeat.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with an error envelope or an HTTP 400 other than a missing entity.',
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
      when: 'IODA has no metadata entity for a country, region, or geoasn code (HTTP 400), or returns HTTP 404. IODA synthesizes metadata for any ASN, so an unknown ASN returns no series instead.',
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
      when: 'IODA data or bucket metadata does not validate, or the response body is over 4 MiB.',
      recovery:
        'Retry ioda_get_signals once with a narrower window; if the response still cannot be parsed, stop this investigation and report the response schema failure.',
    },
  ],
  async handler(input, ctx) {
    const { now, deadline } = invocationClock();
    validateWindow(input, now);
    const asOf = Math.floor(now / 1000);
    const source = signalSource(input.source);
    const maxPoints = clampMaxPoints(input.maxPoints, ctx);
    const request = {
      ...requiredEntity(input),
      source,
      from: input.from,
      until: input.until,
      maxPoints: maxPoints.value,
    };
    const result = await getIodaService().getNumericSignals(request, ctx, { deadline });
    return finish(
      Output,
      { ...result, semantics: { source, unit: SIGNAL_UNITS[source], ...semantics[source] } },
      composeEnrichment(request, [
        maxPoints.notice,
        result.series.some((series) => series.step > series.nativeStep) &&
          'Coarse series aggregate underlying samples, so values need not equal an unweighted mean of finer returned buckets; a non-null aggregate cannot establish complete finer-resolution coverage. Request a narrower window with ioda_get_signals to inspect finer observations.',
        !result.series.length && emptySeriesNotice(request, asOf),
        trailingNullNotice(result.series, source, asOf),
      ]),
      ctx,
      'ioda_get_signals',
      deadline,
    );
  },
  format: renderOutput,
});
