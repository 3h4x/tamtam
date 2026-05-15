import { describe, it, expect } from 'vitest';
import { computeNextFire } from '@/lib/workflows/cron/parse-schedule';

// Extracted from the retired __tests__/lib/internal-scheduler.test.ts:
// `computeNextFire` is the only piece of the legacy in-memory scheduler
// that survived intact — it now lives in lib/workflows/cron/parse-schedule.ts
// and is consumed by both seedAgentCrons and the agent-cron task handler.
describe('computeNextFire', () => {
  it('returns a future timestamp for hourly schedule', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const next = computeNextFire('1h', 'agent-x', now);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(3600_000);
  });

  it('returns a future timestamp for sub-hour schedule', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const next = computeNextFire('15m', 'agent-y', now);
    expect(next).toBe(now + 15 * 60_000);
  });

  it('uses agent-stable phase offset (different agents in same period spread out)', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const a = computeNextFire('4h', 'agent-A', now);
    const b = computeNextFire('4h', 'agent-B', now);
    expect(computeNextFire('4h', 'agent-A', now)).toBe(a);
    expect(a).not.toBe(b);
  });

  it('rolls to next-day slot when today\'s window has passed', () => {
    const now = Date.UTC(2026, 0, 1, 23, 59, 0);
    const next = computeNextFire('24h', 'agent-z', now);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  });

  it('handles day-suffix schedules (3d, 7d, 30d) by skipping the hour-grid', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    // Multi-day schedules don't get a stable hour-of-day phase — they fire
    // exactly N days from now via the period-from-now fallback.
    expect(computeNextFire('3d', 'agent-low-freq', now)).toBe(now + 3 * 86400_000);
    expect(computeNextFire('7d', 'agent-weekly', now)).toBe(now + 7 * 86400_000);
    expect(computeNextFire('30d', 'agent-monthly', now)).toBe(now + 30 * 86400_000);
  });
});
