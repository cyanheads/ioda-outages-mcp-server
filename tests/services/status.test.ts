/**
 * @fileoverview Completed native bucket and detection evidence tests.
 * @module tests/services/status
 */
import { describe, expect, it } from 'vitest';
import {
  assessDetection,
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
      nullCount: 1,
      latest: { value: 0, bucketFrom: 1200, bucketUntil: 1500 },
      minimum: 0,
      maximum: 0,
    });
  });
  it('uses an inclusive three native step freshness boundary', () => {
    const input = { ...series, until: 1200, values: [0] };
    expect(summarizeSeries(input, { from: 900, until: 3000 }, 2100).coverage).toBe('recent');
    expect(summarizeSeries(input, { from: 900, until: 3000 }, 2101).coverage).toBe('stale');
  });
  it('distinguishes empty, missing, coarse and ineligible buckets', () => {
    const window = { from: 900, until: 2100 };
    expect(summarizeSeries({ ...series, values: [] }, window, 2100).coverage).toBe('no_data');
    expect(summarizeSeries({ ...series, values: [null, null] }, window, 2100)).toMatchObject({
      coverage: 'no_data',
      nullCount: 2,
    });
    expect(summarizeSeries(series, { from: 901, until: 1199 }, 1199)).toMatchObject({
      coverage: 'unknown',
      nonNullCount: 0,
      nullCount: 0,
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
