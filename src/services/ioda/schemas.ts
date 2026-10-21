/**
 * @fileoverview Lossless IODA records and shared domain contracts.
 * @module services/ioda/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Supported entity vocabulary. */
export const EntityTypeSchema = z.enum(['country', 'region', 'asn']);
/** Numeric measurement sources supported by this server. */
export const NumericSourceSchema = z.enum(['bgp', 'ping-slash24', 'merit-nt']);
/** Event and alert source filters. */
export const SourceSchema = z.enum(['bgp', 'ping-slash24', 'merit-nt', 'gtr']);
const extras = z.json();
/** Upstream entity metadata; metadata does not establish coverage. */
export const EntitySchema = z
  .object({
    code: z.string().describe('Source entity code'),
    name: z.string().describe('Source entity name'),
    type: z.string().nullable().optional().describe('Source entity type, if reported'),
    subnames: z.array(extras).optional().describe('Additional source names'),
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
    value: z.number().nullable().optional().describe('Source measurement'),
    historyValue: z.number().nullable().optional().describe('Source baseline'),
  })
  .catchall(extras)
  .describe('Source detection or recovery transition');
/** Source outage event; boundaries are not current-state verdicts. */
export const EventSchema = z
  .object({
    entity: EntitySchema.describe('Entity measured'),
    from: z.number().int().describe('Source start Unix seconds UTC'),
    until: z.number().int().describe('Source end Unix seconds UTC'),
    score: z.number().describe('Unmodified source score'),
    datasource: z.string().optional().describe('Measurement source'),
    method: z.string().optional().describe('Source detection method'),
    alerts: z.array(AlertSchema).optional().describe('Nested transitions, when requested'),
  })
  .catchall(extras)
  .describe('Source outage event with original timing and score');
/** Numeric buckets, including missing and aligned boundary buckets. */
export const NumericSeriesSchema = z
  .object({
    entityType: z.string().describe('Source entity type'),
    entityCode: z.string().describe('Source entity code'),
    datasource: z.string().describe('Measurement source'),
    entityName: z.string().optional().describe('Source entity name'),
    entityFqid: z.string().optional().describe('Source fully qualified entity identifier'),
    subtype: z.string().optional().describe('Source measurement subtype'),
    from: z.number().int().describe('First aggregate bucket anchor, Unix seconds UTC'),
    until: z.number().int().describe('Exclusive returned bucket bound, Unix seconds UTC'),
    step: z.number().int().positive().describe('Returned bucket width in seconds'),
    nativeStep: z.number().int().positive().describe('Native measurement width in seconds'),
    values: z.array(z.number().nullable()).describe('All numeric or missing aggregate values'),
  })
  .catchall(extras)
  .describe('Numeric source buckets, including missing observations');
/** Endpoint-specific source attribution and fetch timing. */
export const ProvenanceSchema = z.object({
  endpoint: z
    .string()
    .regex(
      /^https:\/\/api\.ioda\.inetintel\.cc\.gatech\.edu\/v2\/(?:entities\/query|outages\/(?:events|alerts)|signals\/raw\/(?:country|region|asn)\/[^\s/?#]+)$/,
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
  more: z.enum(['possible', 'no']).describe('Whether another page may exist'),
  nextPage: z.number().int().nonnegative().optional().describe('Next page when another may exist'),
});
/** Required entity pair. */
export const EntityReferenceSchema = z.object({
  entityType: EntityTypeSchema.describe('Canonical entity type'),
  entityCode: z.string().describe('Canonical entity code'),
});
/** Exact requested time window. */
export const WindowSchema = z.object({
  from: z.number().int().describe('Inclusive requested Unix seconds UTC'),
  until: z.number().int().describe('Exclusive requested Unix seconds UTC'),
});
/** Coverage labels describe observation availability, never health. */
export const CoverageSchema = z.enum(['recent', 'stale', 'no_data', 'unknown']);
/** In-window completed-bucket statistics without raw samples. */
export const SeriesSummarySchema = NumericSeriesSchema.omit({ values: true })
  .strip()
  .extend({
    coverage: CoverageSchema.describe('Observation availability under the server freshness policy'),
    nonNullCount: z.number().int().nonnegative().describe('Completed in-window numeric buckets'),
    nullCount: z.number().int().nonnegative().describe('Completed in-window missing buckets'),
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
          coverage: CoverageSchema.describe('Source coverage precedence'),
          series: z.array(SeriesSummarySchema).describe('Independent subtype summaries'),
        })
        .describe('Coverage and independent subtype summaries for one core source'),
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
