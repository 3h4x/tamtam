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
});
