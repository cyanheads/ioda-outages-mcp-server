/**
 * @fileoverview Pure completed-bucket coverage and detection assessment.
 * @module services/ioda/status
 */
import type {
  Alert,
  Coverage,
  Event,
  NumericSeries,
  NumericSource,
  SeriesSummary,
  SignalSource,
  TimeWindow,
} from './schemas.js';

/**
 * How long after a completed bucket ends it may still be published. Merit and GTR publish in
 * batches. These allowances reflect observed lag and are server policy.
 */
export const STATUS_PUBLICATION_ALLOWANCES = {
  bgp: 1800,
  'ping-slash24': 1800,
  'merit-nt': 10800,
} as const satisfies Record<NumericSource, number>;

/** Publication allowances for every source served by ioda_get_signals. */
export const PUBLICATION_ALLOWANCES = {
  ...STATUS_PUBLICATION_ALLOWANCES,
  gtr: 10800,
} as const satisfies Record<SignalSource, number>;

/** Summarize completed buckets without inferring replacement intervals or health. */
export function summarizeSeries(
  series: NumericSeries,
  window: TimeWindow,
  asOf: number,
  allowanceSeconds: number,
): SeriesSummary {
  const { values, ...metadata } = series;
  const eligible = values.flatMap((value, index) => {
    const bucketFrom = series.from + index * series.step;
    const bucketUntil = bucketFrom + series.step;
    return bucketFrom >= window.from && bucketUntil <= window.until && bucketUntil <= asOf
      ? [{ value, bucketFrom, bucketUntil }]
      : [];
  });
  const numeric = eligible.filter(
    (bucket): bucket is typeof bucket & { value: number } => bucket.value !== null,
  );
  const latest = numeric.at(-1);
  const pendingCount = eligible
    .slice(eligible.findLastIndex((bucket) => bucket.value !== null) + 1)
    .filter((bucket) => asOf - bucket.bucketUntil <= allowanceSeconds).length;
  const nullCount = eligible.length - numeric.length - pendingCount;
  const extrema =
    latest &&
    numeric.reduce(
      (bounds, bucket) => ({
        minimum: Math.min(bounds.minimum, bucket.value),
        maximum: Math.max(bounds.maximum, bucket.value),
      }),
      { minimum: latest.value, maximum: latest.value },
    );
  const coverage: Coverage =
    values.length === 0
      ? 'no_data'
      : eligible.length === 0
        ? 'unknown'
        : !latest
          ? nullCount > 0
            ? 'no_data'
            : 'unknown'
          : series.step !== series.nativeStep
            ? 'unknown'
            : asOf - latest.bucketUntil <= allowanceSeconds
              ? 'recent'
              : 'stale';
  return {
    entityType: metadata.entityType,
    entityCode: metadata.entityCode,
    datasource: metadata.datasource,
    ...(metadata.entityName !== undefined && { entityName: metadata.entityName }),
    ...(metadata.entityFqid !== undefined && { entityFqid: metadata.entityFqid }),
    ...(metadata.subtype !== undefined && { subtype: metadata.subtype }),
    from: metadata.from,
    until: metadata.until,
    step: metadata.step,
    nativeStep: metadata.nativeStep,
    coverage,
    nonNullCount: numeric.length,
    nullCount,
    pendingCount,
    ...(latest && {
      latest,
      ...extrema,
    }),
  };
}
/** Preserve source coverage precedence without combining subtype measurements. */
export function sourceCoverage(series: readonly SeriesSummary[]): Coverage {
  for (const coverage of ['recent', 'stale', 'unknown', 'no_data'] as const) {
    if (series.some((item) => item.coverage === coverage)) return coverage;
  }
  return 'no_data';
}
/** Interpret only verified detection evidence, never absence as health. */
export function assessDetection(
  events: readonly Event[] | undefined,
  alerts: readonly Alert[] | undefined,
): 'observed' | 'none_returned' | 'unknown' {
  if (events?.length || alerts?.some((alert) => alert.level === 'critical')) return 'observed';
  return events?.length === 0 && alerts?.length === 0 ? 'none_returned' : 'unknown';
}
