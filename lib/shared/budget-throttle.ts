export interface WeeklyQuotaWindow {
  utilization: number;
  resetsAt: string | null;
  msUntilReset: number | null;
}

export interface WeeklyBurnThrottle {
  projectedPct: number;
  resumesAtMs: number;
  reason: string;
}

export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_WEEKLY_THROTTLE_ELAPSED_MS = 6 * 60 * 60 * 1000;
export const EARLY_WEEKLY_THROTTLE_USAGE_PCT = 20;

export function computeWeeklyBurnThrottle(
  win: WeeklyQuotaWindow,
  now = Date.now(),
): WeeklyBurnThrottle | null {
  if (win.msUntilReset == null || win.msUntilReset <= 0) return null;

  const elapsedMs = SEVEN_DAY_WINDOW_MS - win.msUntilReset;
  if (elapsedMs <= 0) return null;

  const projectedPct = win.utilization * (SEVEN_DAY_WINDOW_MS / elapsedMs);
  if (projectedPct <= 100) return null;

  const stableEnough =
    elapsedMs >= MIN_WEEKLY_THROTTLE_ELAPSED_MS ||
    win.utilization >= EARLY_WEEKLY_THROTTLE_USAGE_PCT;
  if (!stableEnough) return null;

  const requiredElapsedMs = win.utilization * SEVEN_DAY_WINDOW_MS / 100;
  // Cap the wait at the next reset boundary. Without the cap, a window
  // where utilization is already over 100% pushes `requiredElapsedMs`
  // past `SEVEN_DAY_WINDOW_MS`, so `msUntilResume` could exceed
  // `msUntilReset` — telling the operator "resume in 8 days" when the
  // budget refills 6.75 days from now and the throttle releases
  // automatically at the reset. The cap aligns the reported resume time
  // with the soonest moment scheduling will actually resume.
  const msUntilResume = Math.min(
    Math.max(0, requiredElapsedMs - elapsedMs),
    win.msUntilReset,
  );

  return {
    projectedPct,
    resumesAtMs: now + msUntilResume,
    reason: `7d burn rate too high: ${win.utilization.toFixed(0)}% used, projected ${projectedPct.toFixed(0)}%`,
  };
}
