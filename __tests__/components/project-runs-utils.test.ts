// Unit tests for the formatting and bucketing utilities in project-runs/utils.ts
// These functions have no existing test coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatTokens,
  formatCost,
  bucketOf,
  buildReleaseSummary,
  dayLabel,
} from '@/components/project-runs/utils';
import type { Entry } from '@/components/project-runs/utils';

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe('formatDuration', () => {
  it('shows seconds for < 60s', () => {
    const now = 1000;
    expect(formatDuration(now, now + 45)).toBe('45s');
  });

  it('shows 0s when finished_at equals started_at', () => {
    expect(formatDuration(1000, 1000)).toBe('0s');
  });

  it('shows minutes and seconds for 60s–3599s', () => {
    expect(formatDuration(0, 90)).toBe('1m 30s');
    expect(formatDuration(0, 3599)).toBe('59m 59s');
  });

  it('shows hours and minutes for >= 3600s', () => {
    expect(formatDuration(0, 3600)).toBe('1h 0m');
    expect(formatDuration(0, 7260)).toBe('2h 1m');
  });

  it('uses current time when finishedAt is null', () => {
    const now = Date.now() / 1000;
    const startedAt = now - 30;
    const result = formatDuration(startedAt, null);
    // Should be ~30s; allow ±2s for timing
    expect(result).toMatch(/^(2[89]|30|31|32)s$/);
  });
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------
describe('formatTokens', () => {
  it('shows raw number below 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('shows k suffix for 1000–999999', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(999999)).toBe('1000.0k');
  });

  it('shows M suffix for >= 1000000', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------
describe('formatCost', () => {
  it('shows $0.00 for zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('shows <$0.0001 for very small amounts', () => {
    expect(formatCost(0.00001)).toBe('<$0.0001');
  });

  it('shows 4 decimal places for amounts < $0.01', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
  });

  it('shows 2 decimal places for amounts >= $0.01', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(12.345)).toBe('$12.35');
  });
});

// ---------------------------------------------------------------------------
// bucketOf
// ---------------------------------------------------------------------------
describe('bucketOf', () => {
  const cases: Array<[string, string]> = [
    ['run', 'run'],
    ['release', 'release'],
    ['review', 'review'],
    ['test', 'test'],
    ['fix', 'fix'],
    ['fix-ci', 'fix-ci'],
    ['fix-push', 'fix-push'],
    ['commit', 'commit'],
    ['push', 'push'],
    ['mark-dod', 'mark-dod'],
    ['pr-wait', 'pr-wait'],
    ['agent:cto', 'agent'],
    ['agent:tests', 'agent'],
    ['unknown-kind', 'other'],
    ['custom-action', 'other'],
  ];

  for (const [kind, expected] of cases) {
    it(`maps ${kind} → ${expected}`, () => {
      expect(bucketOf(kind)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// buildReleaseSummary
// ---------------------------------------------------------------------------
function makeEntry(partial: {
  kind: string;
  status?: 'running' | 'done';
  exitCode?: number | null;
  verdict?: string;
}): Entry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    key: `job:${partial.kind}`,
    kind: partial.kind,
    bucket: partial.kind as Entry['bucket'],
    title: partial.kind,
    subtitle: null,
    startedAt: 1000,
    lastActivityAt: 1000,
    finishedAt: partial.status === 'running' ? null : 2000,
    status: partial.status ?? 'done',
    exitCode: partial.exitCode !== undefined ? partial.exitCode : 0,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 1,
    model: null,
    navJobId: partial.kind,
    navSessionId: null,
    verdict: partial.verdict as Entry['verdict'],
    logPruned: false,
    parentJobId: null,
    parentLabel: null,
  } as Entry;
}

describe('buildReleaseSummary', () => {
  it('returns (no steps) for empty children', () => {
    expect(buildReleaseSummary([])).toBe('(no steps)');
  });

  it('shows ✓ for successful steps', () => {
    const kids = [makeEntry({ kind: 'test' }), makeEntry({ kind: 'commit' })];
    expect(buildReleaseSummary(kids)).toBe('test ✓ · commit ✓');
  });

  it('shows verdict for a review with LGTM', () => {
    const kids = [makeEntry({ kind: 'review', verdict: 'LGTM' })];
    expect(buildReleaseSummary(kids)).toBe('review LGTM');
  });

  it('shows ✗ with exit code for failed steps', () => {
    const kids = [makeEntry({ kind: 'test', exitCode: 1 })];
    expect(buildReleaseSummary(kids)).toBe('test ✗1');
  });

  it('shows … for running steps', () => {
    const kids = [makeEntry({ kind: 'push', status: 'running', exitCode: null })];
    expect(buildReleaseSummary(kids)).toBe('push …');
  });

  it('shows dod for mark-dod steps', () => {
    const kids = [makeEntry({ kind: 'mark-dod' })];
    expect(buildReleaseSummary(kids)).toBe('dod ✓');
  });

  it('builds full pipeline summary', () => {
    const kids = [
      makeEntry({ kind: 'test' }),
      makeEntry({ kind: 'review', verdict: 'LGTM' }),
      makeEntry({ kind: 'commit' }),
      makeEntry({ kind: 'push' }),
    ];
    expect(buildReleaseSummary(kids)).toBe('test ✓ · review LGTM · commit ✓ · push ✓');
  });
});

// ---------------------------------------------------------------------------
// dayLabel
// ---------------------------------------------------------------------------
describe('dayLabel', () => {
  beforeEach(() => {
    // Fix "now" to a known Tuesday: 2026-01-06 12:00:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-06T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns Today for a timestamp from today', () => {
    const ts = new Date('2026-01-06T08:00:00Z').getTime() / 1000;
    expect(dayLabel(ts)).toBe('Today');
  });

  it('returns Yesterday for a timestamp from yesterday', () => {
    const ts = new Date('2026-01-05T10:00:00Z').getTime() / 1000;
    expect(dayLabel(ts)).toBe('Yesterday');
  });

  it('returns weekday name for 2–6 days ago', () => {
    const ts = new Date('2026-01-03T10:00:00Z').getTime() / 1000; // Saturday
    const result = dayLabel(ts);
    expect(result).toBe('Saturday');
  });

  it('returns locale date for 7+ days ago in same year', () => {
    const ts = new Date('2025-12-28T10:00:00Z').getTime() / 1000;
    const result = dayLabel(ts);
    // Should be a formatted date without year — just verify it's not Today/Yesterday/weekday
    expect(result).not.toBe('Today');
    expect(result).not.toBe('Yesterday');
    expect(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']).not.toContain(result);
  });
});
