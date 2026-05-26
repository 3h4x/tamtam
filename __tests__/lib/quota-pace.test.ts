import { describe, it, expect } from 'vitest';
import {
  FIVE_HOUR_WINDOW_MS,
  computeWindowPace,
  computeSnapshotPace,
  computeGlobalPace,
} from '@/lib/usage/quota-pace';
import { SEVEN_DAY_WINDOW_MS } from '@/lib/shared/budget-throttle';

const pct = (frac: number) => SEVEN_DAY_WINDOW_MS - Math.round(frac * SEVEN_DAY_WINDOW_MS);

describe('computeWindowPace', () => {
  it('reports headroom when under the fair-share pace line', () => {
    // 50% of the 7d window elapsed, only 26% used.
    const p = computeWindowPace({ utilization: 26, msUntilReset: pct(0.5) }, SEVEN_DAY_WINDOW_MS)!;
    expect(p.elapsedPct).toBe(50);
    expect(p.paceMarginPct).toBe(24); // 24 points of headroom to the pace line
    expect(p.projectedPct).toBe(52);
    expect(p.remainingPct).toBe(74);
    expect(p.status).toBe('under_pace');
  });

  it('flags will_exceed when projected past 100% before reset', () => {
    // 27% elapsed, 30% used → projects to ~111%.
    const p = computeWindowPace({ utilization: 30, msUntilReset: pct(0.27) }, SEVEN_DAY_WINDOW_MS)!;
    expect(p.elapsedPct).toBe(27);
    expect(p.paceMarginPct).toBe(-3); // 3 points OVER pace
    expect(p.projectedPct).toBe(111);
    expect(p.status).toBe('will_exceed');
  });

  it('marks a maxed window as exceeded', () => {
    const p = computeWindowPace({ utilization: 105, msUntilReset: 100_000 }, SEVEN_DAY_WINDOW_MS)!;
    expect(p.status).toBe('exceeded');
    expect(p.remainingPct).toBe(0);
  });

  it('returns unknown projection when no reset timestamp is available', () => {
    const p = computeWindowPace({ utilization: 40, msUntilReset: null }, SEVEN_DAY_WINDOW_MS)!;
    expect(p.projectedPct).toBeNull();
    expect(p.status).toBe('unknown');
    expect(p.remainingPct).toBe(60);
  });

  it('returns null for a missing window', () => {
    expect(computeWindowPace(null, SEVEN_DAY_WINDOW_MS)).toBeNull();
  });
});

describe('computeSnapshotPace', () => {
  it('computes both windows of a snapshot', () => {
    const pace = computeSnapshotPace({
      fiveHour: { utilization: 0, msUntilReset: FIVE_HOUR_WINDOW_MS / 2 },
      sevenDay: { utilization: 26, msUntilReset: pct(0.5) },
    });
    expect(pace.fiveHour?.status).toBe('under_pace');
    expect(pace.sevenDay?.paceMarginPct).toBe(24);
  });
});

describe('computeGlobalPace', () => {
  it('binds to the tightest provider/window across the fleet', () => {
    const g = computeGlobalPace([
      {
        provider: 'codex',
        snapshot: {
          fiveHour: { utilization: 0, msUntilReset: FIVE_HOUR_WINDOW_MS / 2 },
          sevenDay: { utilization: 26, msUntilReset: pct(0.5) }, // +24 headroom
        },
      },
      {
        provider: 'claude',
        snapshot: {
          fiveHour: { utilization: 2, msUntilReset: FIVE_HOUR_WINDOW_MS / 2 },
          sevenDay: { utilization: 30, msUntilReset: pct(0.27) }, // -3, will exceed
        },
      },
    ]);
    expect(g.bindingProvider).toBe('claude');
    expect(g.bindingWindow).toBe('7d');
    expect(g.marginPct).toBe(-3);
    expect(g.projectedPct).toBe(111);
    expect(g.status).toBe('will_exceed');
    expect(g.providers).toHaveLength(2);
  });

  it('ignores providers with no cached snapshot', () => {
    const g = computeGlobalPace([
      { provider: 'codex', snapshot: { sevenDay: { utilization: 10, msUntilReset: pct(0.5) } } },
      { provider: 'claude', snapshot: null },
    ]);
    expect(g.providers).toHaveLength(1);
    expect(g.bindingProvider).toBe('codex');
  });

  it('skips windows with status=unknown when picking the binding constraint', () => {
    // claude.5h has no msUntilReset → marginPct=0 status=unknown. A naive
    // "lowest margin wins" would let it bind and zero out the global pace,
    // hiding the real under_pace headroom on the other windows.
    const g = computeGlobalPace([
      {
        provider: 'codex',
        snapshot: {
          fiveHour: { utilization: 1, msUntilReset: FIVE_HOUR_WINDOW_MS * 0.835 }, // +15ish under_pace
          sevenDay: { utilization: 15, msUntilReset: pct(0.416) },                  // +26 under_pace
        },
      },
      {
        provider: 'claude',
        snapshot: {
          fiveHour: { utilization: 0, msUntilReset: null },                          // unknown — must be skipped
          sevenDay: { utilization: 45, msUntilReset: pct(0.768) },                   // +31 under_pace
        },
      },
    ]);
    expect(g.status).toBe('under_pace');
    expect(g.bindingProvider).toBe('codex');
    expect(g.bindingWindow).toBe('5h');
    expect(g.marginPct).not.toBe(0);
    expect(g.marginPct).toBeGreaterThan(0);
  });

  it('returns unknown when every measured window is unknown', () => {
    const g = computeGlobalPace([
      {
        provider: 'codex',
        snapshot: {
          fiveHour: { utilization: 0, msUntilReset: null },
          sevenDay: { utilization: 0, msUntilReset: null },
        },
      },
    ]);
    expect(g.status).toBe('unknown');
    expect(g.bindingProvider).toBeNull();
    expect(g.marginPct).toBeNull();
  });
});
