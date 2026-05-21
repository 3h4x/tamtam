import { describe, expect, it } from 'vitest';
import {
  computeWeeklyBurnThrottle,
  SEVEN_DAY_WINDOW_MS,
} from '@/lib/shared/budget-throttle';

describe('budget-throttle', () => {
  const now = Date.UTC(2026, 4, 2, 8, 0, 0);

  it('does not throttle tiny usage in the first hour after weekly reset', () => {
    const burn = computeWeeklyBurnThrottle({
      utilization: 1,
      resetsAt: '2026-05-09T07:00:00.000Z',
      msUntilReset: SEVEN_DAY_WINDOW_MS - 60 * 60 * 1000,
    }, now);

    expect(burn).toBeNull();
  });

  it('throttles once the weekly projection is high after a stable sample period', () => {
    const burn = computeWeeklyBurnThrottle({
      utilization: 5,
      resetsAt: '2026-05-09T02:00:00.000Z',
      msUntilReset: SEVEN_DAY_WINDOW_MS - 6 * 60 * 60 * 1000,
    }, now);

    expect(burn).not.toBeNull();
    expect(burn!.projectedPct).toBeCloseTo(140);
    expect(burn!.reason).toContain('projected 140%');
  });

  it('throttles very high early usage before the stable sample period', () => {
    const burn = computeWeeklyBurnThrottle({
      utilization: 20,
      resetsAt: '2026-05-09T07:00:00.000Z',
      msUntilReset: SEVEN_DAY_WINDOW_MS - 60 * 60 * 1000,
    }, now);

    expect(burn).not.toBeNull();
    expect(burn!.projectedPct).toBeCloseTo(3360);
  });

  it('fails open without a reset timestamp', () => {
    expect(computeWeeklyBurnThrottle({
      utilization: 50,
      resetsAt: null,
      msUntilReset: null,
    }, now)).toBeNull();
  });

  it('caps resumesAtMs at the next reset (regression: previously overshot when utilization > 100%)', () => {
    // Already at 120% utilization, 6h into the window. Without the cap,
    // `requiredElapsedMs` = 120% * 7d / 100% = 8.4d, so msUntilResume
    // would be ~8.15d — past the actual 6.75d msUntilReset. The cap
    // pulls it back so the UI reports the reset time, not a fictional
    // post-reset extrapolation.
    const msUntilReset = SEVEN_DAY_WINDOW_MS - 6 * 60 * 60 * 1000;
    const burn = computeWeeklyBurnThrottle({
      utilization: 120,
      resetsAt: '2026-05-09T02:00:00.000Z',
      msUntilReset,
    }, now);
    expect(burn).not.toBeNull();
    // Resume at or before the reset boundary.
    const resumeOffsetMs = burn!.resumesAtMs - now;
    expect(resumeOffsetMs).toBeLessThanOrEqual(msUntilReset);
    // Specifically, since utilization > 100, the cap kicks in and
    // resumesAtMs lands exactly at the reset.
    expect(resumeOffsetMs).toBe(msUntilReset);
  });

  it('resume time is never later than the reset for any utilization value', () => {
    // Property-style check: for a range of plausible utilizations the
    // capped resumesAtMs must not exceed msUntilReset.
    const msUntilReset = SEVEN_DAY_WINDOW_MS - 6 * 60 * 60 * 1000;
    for (const utilization of [21, 50, 99, 100, 101, 200, 1000]) {
      const burn = computeWeeklyBurnThrottle({
        utilization,
        resetsAt: '2026-05-09T02:00:00.000Z',
        msUntilReset,
      }, now);
      if (burn) {
        expect(burn.resumesAtMs - now).toBeLessThanOrEqual(msUntilReset);
      }
    }
  });
});
