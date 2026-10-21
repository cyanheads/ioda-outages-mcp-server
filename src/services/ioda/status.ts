/**
 * @fileoverview Pure completed-bucket coverage and detection assessment.
 * @module services/ioda/status
 */
import type {
  Alert,
  Coverage,
  Event,
  NumericSeries,
  SeriesSummary,
  TimeWindow,
} from './schemas.js';

/** Summarize completed buckets without inferring replacement intervals or health. */
export function summarizeSeries(
  series: NumericSeries,
  window: TimeWindow,
  asOf: number,
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
          ? 'no_data'
          : series.step !== series.nativeStep
            ? 'unknown'
            : asOf - latest.bucketUntil <= 3 * series.nativeStep
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
    nullCount: eligible.length - numeric.length,
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
