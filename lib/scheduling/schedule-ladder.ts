// Cadence + model-tier ladders, shared by the recommendations UI ("Decrease
// rate") and the server-side autopilot. One source of truth so the manual and
// automatic throttle paths step through the same rungs.

import type { ModelTier } from '@/lib/agents/model-aliases';

// Cadence ladder, ascending by duration. Stepping "slower" moves toward 7d;
// "faster" moves back toward 15m.
export const CADENCE_LADDER = ['15m', '1h', '4h', '8h', '24h', '7d'] as const;
export type CadenceRung = (typeof CADENCE_LADDER)[number];

// When the current cadence is unknown/unparseable we can't place it on the
// ladder; callers that still want a throttle default to a conservative 8h.
export const DEFAULT_BACKOFF_SCHEDULE: CadenceRung = '8h';

/** Parse a cadence string like "30m" / "4h" / "2d" to fractional hours.
 *  Returns null for anything unparseable (e.g. a raw cron expression). */
export function scheduleHours(schedule: unknown): number | null {
  if (typeof schedule !== 'string') return null;
  const match = schedule.trim().match(/^(\d+)([mhd])$/i);
  if (!match) return null;
  const [, rawValue, unit] = match;
  if (!rawValue || !unit) return null;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (unit.toLowerCase()) {
    case 'm':
      return value / 60;
    case 'd':
      return value * 24;
    default:
      return value;
  }
}

/** Next-slower rung strictly above `current`, bounded by `floor` (never step
 *  past the floor cadence). Returns null when already at/over the floor or the
 *  slowest rung, or when `current` is unparseable. */
export function nextSlowerSchedule(
  current: unknown,
  floor: string = CADENCE_LADDER[CADENCE_LADDER.length - 1],
): string | null {
  const currentHours = scheduleHours(current);
  if (currentHours == null) return null;
  const floorHours = scheduleHours(floor) ?? Infinity;
  for (const step of CADENCE_LADDER) {
    const stepHours = scheduleHours(step);
    if (stepHours != null && stepHours > currentHours && stepHours <= floorHours) {
      return step;
    }
  }
  return null;
}

// Model-tier ladder, descending by cost/capability. Downgrading steps
// smart -> normal -> fast; upgrading reverses it.
export const TIER_LADDER: readonly ModelTier[] = ['smart', 'normal', 'fast'];

/** Next-cheaper tier below `current`, bounded by `floor`. Returns null when
 *  already at/under the floor (default floor 'fast'). */
export function nextCheaperTier(
  current: ModelTier,
  floor: ModelTier = 'fast',
): ModelTier | null {
  const ci = TIER_LADDER.indexOf(current);
  const fi = TIER_LADDER.indexOf(floor);
  if (ci < 0 || fi < 0) return null;
  const next = ci + 1;
  if (next > fi || next >= TIER_LADDER.length) return null;
  return TIER_LADDER[next];
}
