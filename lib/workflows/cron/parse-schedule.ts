// Schedule parsing + next-fire computation for the cron migration
// (see docs/superpowers/plans/2026-05-15-cron-migration-graphile.md).
//
// `computeNextFire` lives here as the canonical home now that
// internal-scheduler.ts is retired. Pure function: given a schedule
// expression + agent id + reference time, returns the next-fire epoch ms.
// Stable per-agent phase offset so multiple agents on the same period
// don't all fire on the same minute.

import { stableHash } from '@/lib/scheduling/fire-times';
import { normalizeAgentScheduleOrThrow } from '@/lib/scheduling/agent-schedule';

export { normalizeAgentScheduleOrThrow, stableHash };

/**
 * Decide when an agent's next scheduled run should fire from `fromMs`.
 *
 * Supported grammar: "Nm" (15m, 30m, …), "Nh" (1h, 4h, 24h, …), "Nd"
 * (3d, 7d, 30d, …), plus bare seconds.
 * Phase offset is derived from a stable hash of the agentId so different
 * agents with the same period don't all fire on the same minute.
 */
export function computeNextFire(schedule: string, agentId: string, fromMs: number = Date.now()): number {
  const s = normalizeAgentScheduleOrThrow(schedule);
  let periodMs = 0;
  let useHourGrid = false;

  if (s.endsWith('d')) {
    const days = parseInt(s, 10);
    if (!days || days < 1) return fromMs + 86400_000;
    periodMs = days * 86400_000;
    // Periods > 24h skip the hour-grid (no stable per-day phase) — they fire
    // on the next period boundary from now.
    useHourGrid = false;
  } else if (s.endsWith('h')) {
    const hours = parseInt(s, 10);
    if (!hours || hours < 1) return fromMs + 3600_000;
    periodMs = hours * 3600_000;
    useHourGrid = hours <= 24;
  } else if (s.endsWith('m')) {
    const mins = parseInt(s, 10);
    if (!mins || mins < 1) return fromMs + 60_000;
    periodMs = mins * 60_000;
    useHourGrid = mins >= 60 && mins <= 24 * 60;
  } else {
    const secs = parseInt(s, 10) || 60;
    periodMs = secs * 1000;
  }

  if (useHourGrid && periodMs >= 3600_000) {
    // Hour-aligned schedule with stable per-agent phase: pick the next slot
    // matching `(startHour + k * cycleHours) : minOff` after `fromMs`.
    const cycleHours = Math.round(periodMs / 3600_000);
    const startHour = stableHash(agentId + ':h', cycleHours);
    const minOff = stableHash(agentId + ':min', 60);
    const now = new Date(fromMs);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    for (let h = startHour; h < 24 + startHour; h += cycleHours) {
      const candidate = today + h * 3600_000 + minOff * 60_000;
      if (candidate > fromMs) return candidate;
    }
    // Fall back to tomorrow's first slot
    return today + 86400_000 + startHour * 3600_000 + minOff * 60_000;
  }

  // Sub-hour or > 24h interval: fire on next period boundary from now.
  return fromMs + periodMs;
}
