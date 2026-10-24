/**
 * @fileoverview Lossless IODA records and shared domain contracts.
 * @module services/ioda/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import { PUBLICATION_ALLOWANCE_SECONDS } from './status.js';

/** Supported entity vocabulary; a geoasn is one ASN's footprint within a region or country. */
export const EntityTypeSchema = z.enum(['country', 'region', 'asn', 'geoasn']);
/** Numeric measurement sources supported by this server. */
export const NumericSourceSchema = z.enum(['bgp', 'ping-slash24', 'merit-nt']);
/** IODA's published unit for each numeric source, verbatim from its /datasources listing. */
export const SOURCE_UNITS = {
  bgp: 'Visible /24s',
  'ping-slash24': 'Up /24s',
  'merit-nt': 'Unique Source IPs',
} as const satisfies Record<z.infer<typeof NumericSourceSchema>, string>;
/** One numeric source's unit, shared by signal semantics and status entries. */
export const UnitSchema = z
  .enum(SOURCE_UNITS)
  .describe(
    "IODA's published unit for this source's values. Coarse buckets aggregate underlying samples in the same unit; values need not equal an unweighted mean of finer returned buckets, and non-null aggregates do not prove complete finer-resolution coverage.",
  );
/** Event and alert source filters. */
export const SourceSchema = z.enum(['bgp', 'ping-slash24', 'merit-nt', 'gtr']);
const extras = z.json();
/** Upstream entity metadata; metadata does not establish coverage. */
export const EntitySchema = z
  .object({
    code: z.string().describe('Source entity code'),
    name: z.string().describe('Source entity name'),
    type: z.string().nullable().optional().describe('Source entity type, if reported'),
    subnames: extras
      .optional()
      .describe(
        'Additional source names, preserved verbatim: usually a list; geoasn search rows carry named parts such as asn and region or country',
      ),
    attrs: z
      .record(z.string(), extras)
      .optional()
      .describe('Source attributes, preserved verbatim'),
  })
  .catchall(extras)
  .describe('Entity metadata with unmodified source attributes');
/** Detection or recovery transition, preserving source uncertainty. */
export const AlertSchema = z
  .object({
    entity: EntitySchema.describe('Entity measured'),
    datasource: z.string().describe('Measurement source'),
    time: z.number().int().describe('Transition Unix seconds UTC'),
    level: z.string().nullable().optional().describe('Literal source level'),
    condition: z.string().nullable().optional().describe('Literal detection condition'),
    method: z.string().nullable().optional().describe('Source detection method'),
    value: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Source measurement at the transition. bgp (Visible /24s), ping-slash24 (Up /24s), and merit-nt (Unique Source IPs) report it in the source unit; gtr (method sarima) reports IODA Traffic divided by 1,000,000 and truncated to an integer.',
      ),
    historyValue: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Source baseline that value is compared with, on the same per-source scale as value: the source unit for bgp, ping-slash24, and merit-nt; Traffic divided by 1,000,000 and truncated for gtr.',
      ),
  })
  .catchall(extras)
  .describe('Source detection or recovery transition');
/** Source outage event; boundaries are not current-state verdicts. */
export const EventSchema = z
  .object({
    entity: EntitySchema.describe('Entity measured'),
    from: z
      .number()
      .int()
      .describe(
        'Source start Unix seconds UTC; starts at the inclusive requested until can be returned, and overlapping events may start before from',
      ),
    until: z
      .number()
      .int()
      .describe(
        'Source end Unix seconds UTC; may be clipped to the query boundary and does not establish recovery',
      ),
    score: z.number().describe('Unmodified source score'),
    datasource: z.string().optional().describe('Measurement source'),
    method: z.string().optional().describe('Source detection method'),
    alerts: z.array(AlertSchema).optional().describe('Nested transitions, when requested'),
  })
  .catchall(extras)
  .describe('Source outage event with original timing and score');
/** IODA's own per-entity ranking row over one window, relayed without local scoring. */
export const SummarySchema = z
  .object({
    entity: EntitySchema.describe('Entity ranked'),
    scores: z
      .object({
        overall: z
          .number()
          .describe(
            "IODA's ranking score: overlapping events from different sources are merged, each merged event scores the product of its sources' scores, and overall sums the merged events",
          ),
      })
      .catchall(z.number())
      .describe(
        'Unmodified window-total scores: overall plus one sum of event scores per <source>.<method> key, such as bgp.median or gtr.sarima',
      ),
    event_cnt: z
      .number()
      .int()
      .describe("IODA's count of the entity's source events before merging"),
  })
  .catchall(extras)
  .describe("One entity's unmodified IODA outage summary for the window");
/** Numeric buckets, including missing and aligned boundary buckets. */
export const NumericSeriesSchema = z
  .object({
    entityType: z.string().describe('Source entity type'),
    entityCode: z.string().describe('Source entity code'),
    datasource: z.string().describe('Measurement source'),
    entityName: z.string().optional().describe('Source entity name'),
    entityFqid: z.string().optional().describe('Source fully qualified entity identifier'),
    subtype: z.string().optional().describe('Source measurement subtype'),
    from: z
      .number()
      .int()
      .describe(
        'First aggregate bucket anchor, Unix seconds UTC; alignment can place it before the requested from',
      ),
    until: z
      .number()
      .int()
      .describe(
        'Exclusive returned bucket bound, Unix seconds UTC; alignment can place it after the requested until',
      ),
    step: z.number().int().positive().describe('Returned bucket width in seconds'),
    nativeStep: z.number().int().positive().describe('Native measurement width in seconds'),
    values: z
      .array(z.number().nullable())
      .describe(
        'All numeric or missing upstream aggregate values; a non-null coarse value can conceal missing finer observations',
      ),
  })
  .catchall(extras)
  .describe('Numeric source buckets, including missing observations');
/** Endpoint-specific source attribution and fetch timing. */
export const ProvenanceSchema = z.object({
  endpoint: z
    .string()
    .regex(
      /^https:\/\/api\.ioda\.inetintel\.cc\.gatech\.edu\/v2\/(?:entities\/query|outages\/(?:events|alerts|summary)|signals\/raw\/(?:country|region|asn|geoasn)\/[^\s/?#]+)$/,
    )
    .describe('Fixed HTTPS IODA upstream endpoint URL'),
  fetchedAt: z.iso.datetime().describe('Fetch completion time UTC'),
  requestTime: extras.optional().describe('Unmodified source request time'),
  responseTime: extras.optional().describe('Unmodified source response time'),
  copyright: extras.optional().describe('Unmodified source attribution'),
});
/** One upstream zero-based page, with no fabricated total. */
export const PaginationSchema = z.object({
  page: z.number().int().nonnegative().describe('Zero-based upstream page'),
  limit: z.number().int().positive().describe('Requested page size'),
  returned: z.number().int().nonnegative().describe('Returned record count'),
  more: z
    .enum(['possible', 'no'])
    .describe(
      'Whether another row page may exist; no does not verify related-scope membership coverage',
    ),
  nextPage: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Next page when another may exist and IODA can continue the request; absent from a full page it cannot continue, whose notice names the route to the rest',
    ),
});
/** Required entity pair. */
export const EntityReferenceSchema = z.object({
  entityType: EntityTypeSchema.describe('Canonical entity type'),
  entityCode: z.string().describe('Canonical entity code'),
});
/** Exact requested time window. */
export const WindowSchema = z.object({
  from: z
    .number()
    .int()
    .describe('Requested start Unix seconds UTC; component selection and bucket alignment differ'),
  until: z
    .number()
    .int()
    .describe(
      'Requested end Unix seconds UTC; detections include the boundary while returned signal bucket bounds are exclusive',
    ),
});
/** Coverage labels describe observation availability, never health. */
export const CoverageSchema = z.enum(['recent', 'stale', 'no_data', 'unknown']);
/** In-window completed-bucket statistics without raw samples. */
export const SeriesSummarySchema = NumericSeriesSchema.omit({ values: true })
  .strip()
  .extend({
    coverage: CoverageSchema.describe(
      `Observation availability, never health: recent when the latest completed observation ended within the ${PUBLICATION_ALLOWANCE_SECONDS}-second publication allowance of asOf, stale beyond it; no_data for an empty series or one with no observation and a missing bucket; unknown for coarse aggregates, no completed bucket, or only pending buckets`,
    ),
    nonNullCount: z.number().int().nonnegative().describe('Completed in-window numeric buckets'),
    nullCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        `Completed in-window missing buckets: interior gaps and trailing nulls that ended more than ${PUBLICATION_ALLOWANCE_SECONDS} seconds before asOf`,
      ),
    pendingCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        `Completed in-window null buckets after the latest observation that ended within ${PUBLICATION_ALLOWANCE_SECONDS} seconds of asOf; not yet due, not a promise they will be published`,
      ),
    latest: z
      .object({
        value: z.number().describe('Latest eligible non-null aggregate'),
        bucketFrom: z.number().int().describe('Aggregate start Unix seconds UTC'),
        bucketUntil: z.number().int().describe('Aggregate end Unix seconds UTC'),
      })
      .optional()
      .describe('Latest completed in-window observation'),
    minimum: z.number().optional().describe('Minimum eligible aggregate'),
    maximum: z.number().optional().describe('Maximum eligible aggregate'),
  })
  .describe('Completed in-window bucket statistics for one source subtype');
/** Sanitized component failure, without upstream body or URL. */
export const FailureSchema = z.object({
  code: z.number().int().describe('Framework error code'),
  reason: z.string().describe('Classified failure reason'),
  message: z.string().describe('Sanitized failure message'),
  recovery: z.string().describe('Concrete standalone-tool recovery'),
});
/** Per-component result in fixed request order. */
export const ComponentSchema = z
  .object({
    component: z
      .enum(['events', 'alerts', 'bgp', 'ping-slash24', 'merit-nt'])
      .describe('Evidence component'),
    state: z.enum(['ok', 'failed']).describe('Collection outcome'),
    provenance: ProvenanceSchema.optional().describe('Successful component provenance'),
    failure: FailureSchema.optional().describe('Failed component details'),
  })
  .describe('Collection outcome for one status component');
/** Bounded status evidence, deliberately without a health classification. */
export const StatusEvidenceSchema = z.object({
  entity: EntityReferenceSchema.describe('Requested entity'),
  asOf: z.number().int().describe('Captured invocation time, Unix seconds UTC'),
  window: WindowSchema.describe('Exact investigation window'),
  detection: z
    .enum(['observed', 'none_returned', 'unknown'])
    .describe('Returned lookback detection evidence'),
  events: z
    .object({
      items: z.array(EventSchema).describe('Returned events'),
      pagination: PaginationSchema.describe('Event page'),
    })
    .optional()
    .describe('Successful event component'),
  alerts: z
    .object({
      items: z.array(AlertSchema).describe('Returned alerts'),
      pagination: PaginationSchema.describe('Alert page'),
    })
    .optional()
    .describe('Successful alert component'),
  signals: z
    .array(
      z
        .object({
          source: NumericSourceSchema.describe('Numeric source'),
          unit: UnitSchema,
          coverage: CoverageSchema.describe('Source coverage precedence'),
          series: z.array(SeriesSummarySchema).describe('Independent subtype summaries'),
        })
        .describe('Unit, coverage and independent subtype summaries for one core source'),
    )
    .describe('Coverage for each core source'),
  components: z.array(ComponentSchema).describe('Five component outcomes in request order'),
  limitations: z
    .array(z.string())
    .describe('Scope, completeness, alignment and freshness qualifications'),
});
/** Canonical entity type. */
export type EntityType = z.infer<typeof EntityTypeSchema>;
/** Core numeric source. */
export type NumericSource = z.infer<typeof NumericSourceSchema>;
/** Event/alert filter source. */
export type Source = z.infer<typeof SourceSchema>;
/** Lossless entity record. */
export type Entity = z.infer<typeof EntitySchema>;
/** Lossless alert record. */
export type Alert = z.infer<typeof AlertSchema>;
/** Lossless event record. */
export type Event = z.infer<typeof EventSchema>;
/** Lossless per-entity summary row. */
export type Summary = z.infer<typeof SummarySchema>;
/** Lossless numeric series. */
export type NumericSeries = z.infer<typeof NumericSeriesSchema>;
/** Endpoint provenance. */
export type Provenance = z.infer<typeof ProvenanceSchema>;
/** Page continuation metadata. */
export type Pagination = z.infer<typeof PaginationSchema>;
/** Required entity pair. */
export type EntityReference = z.infer<typeof EntityReferenceSchema>;
/** Investigation window. */
export type TimeWindow = z.infer<typeof WindowSchema>;
/** Observation availability. */
export type Coverage = z.infer<typeof CoverageSchema>;
/** Completed bucket summary. */
export type SeriesSummary = z.infer<typeof SeriesSummarySchema>;
/** Five-component status output. */
export type StatusEvidence = z.infer<typeof StatusEvidenceSchema>;
