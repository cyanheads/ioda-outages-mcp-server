/**
 * @fileoverview Completed native bucket and detection evidence tests.
 * @module tests/services/status
 */
import { describe, expect, it } from 'vitest';
import {
  assessDetection,
  PUBLICATION_ALLOWANCE_SECONDS,
  sourceCoverage,
  summarizeSeries,
} from '../../src/services/ioda/status.js';

const series = {
  entityType: 'country',
  entityCode: 'US',
  datasource: 'bgp',
  from: 900,
  until: 2100,
  step: 300,
  nativeStep: 300,
  values: [99, 0, null, 900],
};
describe('completed buckets', () => {
  it('summarizes large valid series below the upstream byte ceiling', () => {
    const values = Array.from({ length: 200000 }, () => 0);
    const input = { ...series, from: 900, until: 60000900, values };
    expect(JSON.stringify(input).length).toBeLessThan(2 * 1024 * 1024);
    expect(summarizeSeries(input, { from: 900, until: 60000900 }, 60000900)).toMatchObject({
      nonNullCount: 200000,
      minimum: 0,
      maximum: 0,
    });
  });
  it('excludes partial and future buckets without discarding zero', () => {
    expect(summarizeSeries(series, { from: 1000, until: 2000 }, 1900)).toMatchObject({
      coverage: 'recent',
      nonNullCount: 1,
      nullCount: 0,
      pendingCount: 1,
      latest: { value: 0, bucketFrom: 1200, bucketUntil: 1500 },
      minimum: 0,
      maximum: 0,
    });
  });
  it('uses one inclusive 1800-second publication allowance for freshness', () => {
    expect(PUBLICATION_ALLOWANCE_SECONDS).toBe(1800);
    const input = { ...series, until: 1200, values: [0] };
    expect(summarizeSeries(input, { from: 900, until: 3000 }, 3000).coverage).toBe('recent');
    expect(summarizeSeries(input, { from: 900, until: 3000 }, 3001).coverage).toBe('stale');
    const probing = {
      ...input,
      datasource: 'ping-slash24',
      step: 600,
      nativeStep: 600,
      until: 1500,
    };
    expect(summarizeSeries(probing, { from: 900, until: 3300 }, 3300).coverage).toBe('recent');
    expect(summarizeSeries(probing, { from: 900, until: 3300 }, 3301).coverage).toBe('stale');
  });
  it('distinguishes empty, missing, coarse and ineligible buckets', () => {
    const window = { from: 900, until: 2100 };
    expect(summarizeSeries({ ...series, values: [] }, window, 2100).coverage).toBe('no_data');
    expect(summarizeSeries({ ...series, values: [null, null] }, window, 3301)).toMatchObject({
      coverage: 'no_data',
      nullCount: 2,
      pendingCount: 0,
    });
    expect(summarizeSeries(series, { from: 901, until: 1199 }, 1199)).toMatchObject({
      coverage: 'unknown',
      nonNullCount: 0,
      nullCount: 0,
      pendingCount: 0,
    });
    expect(summarizeSeries({ ...series, step: 600, values: [1, 2] }, window, 2100)).toMatchObject({
      coverage: 'unknown',
      latest: { value: 2 },
    });
  });
  it('preserves source specific steps and subtype precedence', () => {
    const recent = summarizeSeries(
      { ...series, step: 600, nativeStep: 600, values: [7] },
      { from: 900, until: 3300 },
      3300,
    );
    expect(recent.coverage).toBe('recent');
    expect(
      sourceCoverage([
        { ...recent, coverage: 'unknown' },
        { ...recent, coverage: 'stale' },
      ]),
    ).toBe('stale');
    expect(sourceCoverage([{ ...recent, coverage: 'stale' }, recent])).toBe('recent');
    expect(sourceCoverage([])).toBe('no_data');
  });
});
describe('publication allowance', () => {
  const at = (values: (number | null)[], asOf: number, step = 300, nativeStep = step) => {
    const input = { ...series, from: 0, until: values.length * step, step, nativeStep, values };
    const summary = summarizeSeries(input, { from: 0, until: values.length * step }, asOf);
    const completed = values.filter((_, index) => (index + 1) * step <= asOf).length;
    expect(summary.nonNullCount + summary.nullCount + summary.pendingCount).toBe(completed);
    return summary;
  };
  it.each([
    [
      'a trailing null ending exactly 1800 s before asOf is pending',
      [1, null],
      2400,
      'stale',
      1,
      0,
      1,
    ],
    ['a trailing null ending 1801 s before asOf is missing', [1, null], 2401, 'stale', 1, 1, 0],
    ['an overdue tail splits at the allowance', [1, null, null, null], 2700, 'stale', 1, 1, 2],
    ['an interior null inside the allowance stays missing', [1, null, 2], 900, 'recent', 2, 1, 0],
    ['interior and pending nulls stay separate', [1, null, 2, null], 1200, 'recent', 2, 1, 1],
    ['an all-pending series is unknown', [null, null], 600, 'unknown', 0, 0, 2],
    [
      'an all-null series with an overdue bucket is no_data',
      [null, null],
      2200,
      'no_data',
      0,
      1,
      1,
    ],
    ['a zero observation is not missing', [0, null], 600, 'recent', 1, 0, 1],
  ] as const)('%s', (_, values, asOf, coverage, nonNullCount, nullCount, pendingCount) => {
    expect(at([...values], asOf)).toMatchObject({
      coverage,
      nonNullCount,
      nullCount,
      pendingCount,
    });
  });
  it('keeps coarse aggregates unknown while classifying their trailing nulls', () => {
    expect(at([1, null], 1200, 600, 300)).toMatchObject({
      coverage: 'unknown',
      nonNullCount: 1,
      nullCount: 0,
      pendingCount: 1,
      latest: { value: 1, bucketUntil: 600 },
    });
  });
  /** bgp for asn/22854, read live 2026-10-21 05:32:37 UTC: 1054 s of routine publication lag. */
  const lagging = {
    entityType: 'asn',
    entityCode: '22854',
    entityName: 'AS22854 (CATAWBA-COLLEGE)',
    entityFqid: 'asn.22854',
    datasource: 'bgp',
    subtype: '',
    from: 1792557000,
    until: 1792560900,
    step: 300,
    nativeStep: 300,
    values: [128, 128, 128, 128, 128, 128, 128, 128, 128, null, null, null, null],
  };
  /** bgp for country/US, read live 2026-10-21 05:44:14 UTC: two unpublished buckets. */
  const routine = {
    entityType: 'country',
    entityCode: 'US',
    datasource: 'bgp',
    from: 1792553400,
    until: 1792561500,
    step: 300,
    nativeStep: 300,
    values: [
      4910130,
      4910115,
      4910137,
      4910138,
      4910102,
      4910111,
      4910116,
      4910037,
      4909899,
      4910068,
      4910064,
      4910079,
      4910027,
      4910049,
      4910086,
      4910095,
      4910112,
      4910113,
      4909858,
      4909856,
      4909854,
      4909825,
      4909982,
      4909993,
      null,
      null,
      null,
    ],
  };
  /** merit-nt for country/US, read live 2026-10-21 05:56:01 UTC: no bucket published for 56 minutes. */
  const stalled = {
    entityType: 'country',
    entityCode: 'US',
    datasource: 'merit-nt',
    from: 1792554900,
    until: 1792562400,
    step: 300,
    nativeStep: 300,
    values: [
      4390.4,
      4438.6,
      4520.4,
      4489,
      4425.2,
      4402.2,
      4359.4,
      4333.8,
      4437.8,
      4453.4,
      4492,
      4460.2,
      4399.8,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  };
  it.each([
    [
      'routine lag past three native steps reads recent',
      lagging,
      1792560754,
      3600,
      'recent',
      8,
      0,
      3,
    ],
    ['two unpublished buckets are pending', routine, 1792561454, 7200, 'recent', 21, 0, 2],
    [
      'a stalled feed is stale with its overdue buckets missing',
      stalled,
      1792562161,
      7200,
      'stale',
      12,
      5,
      6,
    ],
  ] as const)(
    '%s on a live series',
    (_, input, asOf, lookback, coverage, nonNullCount, nullCount, pendingCount) => {
      expect(summarizeSeries(input, { from: asOf - lookback, until: asOf }, asOf)).toMatchObject({
        coverage,
        nonNullCount,
        nullCount,
        pendingCount,
      });
    },
  );
});
describe('detection evidence', () => {
  it('never promotes recovery or missing evidence to healthy', () => {
    const alert = {
      entity: { code: 'US', name: 'US' },
      datasource: 'bgp',
      time: 1200,
      level: 'normal',
    };
    expect(assessDetection([], [alert])).toBe('unknown');
    expect(assessDetection([], [{ ...alert, level: 'unfamiliar' }])).toBe('unknown');
    expect(assessDetection([], [])).toBe('none_returned');
    expect(assessDetection(undefined, [])).toBe('unknown');
    expect(assessDetection(undefined, [{ ...alert, level: 'critical' }])).toBe('observed');
  });
});
