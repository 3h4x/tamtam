// Pace math for quota windows. Surfaces, per CLI/provider and globally, how
// much room is left before the "fair-share" pace line (and whether a window is
// projected to blow past 100% by the time it resets).
//
// Fair-share pace = % of the window already elapsed. If utilization tracks
// elapsed%, you finish the window at ~100%. paceMarginPct = elapsedPct -
// utilization: positive means you're UNDER pace (headroom), negative means
// you're OVER pace (burning too fast) by that many points.
import { SEVEN_DAY_WINDOW_MS } from '@/lib/shared/budget-throttle';

export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

export type PaceStatus = 'under_pace' | 'on_pace' | 'will_exceed' | 'exceeded' | 'unknown';

export interface WindowPace {
  windowMs: number;
  /** % of the window already elapsed (the fair-share marker). */
  elapsedPct: number;
  /** Current utilization of this window's quota (0–100+, mirrors the source). */
  utilizationPct: number;
  /** elapsedPct - utilization. >0 = under pace (room before the pace line);
   *  <0 = over pace by that many points. This is "ile brakuje do pace". */
  paceMarginPct: number;
  /** Linear projection of utilization at window reset (null if not yet
   *  measurable). >100 means the window is on track to exceed quota. */
  projectedPct: number | null;
  /** Absolute quota left before the hard 100% cap (clamped 0–100). */
  remainingPct: number;
  status: PaceStatus;
}

export interface PaceWindowInput {
  utilization: number;
  msUntilReset: number | null;
}

export interface GlobalPace {
  status: PaceStatus;
  /** The provider+window that is tightest right now (lowest paceMargin). */
  bindingProvider: string | null;
  bindingWindow: '5h' | '7d' | null;
  /** Tightest paceMargin across all enabled providers/windows: >0 = global
   *  headroom to the pace line, <0 = over pace by that many points. */
  marginPct: number | null;
  /** Projection of the binding window at reset. */
  projectedPct: number | null;
  providers: Array<{ provider: string; fiveHour: WindowPace | null; sevenDay: WindowPace | null }>;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeWindowPace(
  win: PaceWindowInput | null | undefined,
  windowMs: number,
): WindowPace | null {
  if (!win || typeof win.utilization !== 'number') return null;
  const util = win.utilization;
  const remainingPct = round1(Math.max(0, 100 - util));

  // Without a reset timestamp we can't measure elapsed time, so pace/projection
  // are undefined — still report utilization-derived fields.
  if (win.msUntilReset == null || win.msUntilReset <= 0) {
    return {
      windowMs,
      elapsedPct: 0,
      utilizationPct: util,
      paceMarginPct: 0,
      projectedPct: null,
      remainingPct,
      status: util >= 100 ? 'exceeded' : 'unknown',
    };
  }

  const elapsedMs = Math.min(windowMs, Math.max(0, windowMs - win.msUntilReset));
  const elapsedPct = round1((elapsedMs / windowMs) * 100);
  const paceMarginPct = round1(elapsedPct - util);
  const projectedPct = elapsedPct > 0 ? Math.round((util / elapsedPct) * 100) : null;

  let status: PaceStatus;
  if (util >= 100) status = 'exceeded';
  else if (projectedPct != null && projectedPct > 100) status = 'will_exceed';
  else if (paceMarginPct < 0) status = 'on_pace'; // ahead of pace but not projected to exceed
  else status = 'under_pace';

  return { windowMs, elapsedPct, utilizationPct: util, paceMarginPct, projectedPct, remainingPct, status };
}

/** Per-provider pace for the 5-hour and 7-day windows of a quota snapshot. */
export function computeSnapshotPace(
  snapshot: { fiveHour?: PaceWindowInput | null; sevenDay?: PaceWindowInput | null } | null | undefined,
): { fiveHour: WindowPace | null; sevenDay: WindowPace | null } {
  return {
    fiveHour: computeWindowPace(snapshot?.fiveHour, FIVE_HOUR_WINDOW_MS),
    sevenDay: computeWindowPace(snapshot?.sevenDay, SEVEN_DAY_WINDOW_MS),
  };
}

const STATUS_SEVERITY: Record<PaceStatus, number> = {
  under_pace: 0,
  on_pace: 1,
  unknown: 1,
  will_exceed: 2,
  exceeded: 3,
};

/**
 * Cross-provider ("global") pace. The binding constraint is the provider+window
 * with the lowest paceMargin (the tightest spot). marginPct answers "how much
 * pace headroom is left, or by how much are we over" across the whole fleet.
 */
export function computeGlobalPace(
  entries: Array<{
    provider: string;
    snapshot: { fiveHour?: PaceWindowInput | null; sevenDay?: PaceWindowInput | null } | null;
  }>,
): GlobalPace {
  const providers = entries
    .filter((e) => e.snapshot)
    .map((e) => ({
      provider: e.provider,
      fiveHour: computeWindowPace(e.snapshot!.fiveHour, FIVE_HOUR_WINDOW_MS),
      sevenDay: computeWindowPace(e.snapshot!.sevenDay, SEVEN_DAY_WINDOW_MS),
    }));

  let binding: { provider: string; window: '5h' | '7d'; pace: WindowPace } | null = null;
  for (const p of providers) {
    const windows: Array<['5h' | '7d', WindowPace | null]> = [
      ['5h', p.fiveHour],
      ['7d', p.sevenDay],
    ];
    for (const [window, pace] of windows) {
      if (!pace) continue;
      if (
        !binding
        || pace.paceMarginPct < binding.pace.paceMarginPct
        || (pace.paceMarginPct === binding.pace.paceMarginPct
          && STATUS_SEVERITY[pace.status] > STATUS_SEVERITY[binding.pace.status])
      ) {
        binding = { provider: p.provider, window, pace };
      }
    }
  }

  return {
    status: binding ? binding.pace.status : 'unknown',
    bindingProvider: binding?.provider ?? null,
    bindingWindow: binding?.window ?? null,
    marginPct: binding?.pace.paceMarginPct ?? null,
    projectedPct: binding?.pace.projectedPct ?? null,
    providers,
  };
}
