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
  groupReleaseChildren,
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

// ---------------------------------------------------------------------------
// groupReleaseChildren
// ---------------------------------------------------------------------------

function makeReleaseEntry(id: string, startedAt: number, finishedAt: number | null = startedAt + 10, parentJobId: string | null = null): Entry {
  return {
    key: `job:${id}`,
    kind: 'release',
    bucket: 'release',
    title: 'Release pipeline',
    subtitle: null,
    startedAt,
    lastActivityAt: finishedAt ?? startedAt,
    finishedAt,
    status: finishedAt !== null ? 'done' : 'running',
    exitCode: finishedAt !== null ? 0 : null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 1,
    model: null,
    navJobId: id,
    navSessionId: null,
    verdict: undefined,
    logPruned: false,
    parentJobId,
    parentLabel: parentJobId ? 'run' : null,
    _jobIds: [id],
  };
}

function makeStepEntry(id: string, kind: string, startedAt: number, parentJobId: string | null = null, exitCode = 0): Entry {
  return {
    key: `job:${id}`,
    kind,
    bucket: kind as Entry['bucket'],
    title: kind,
    subtitle: null,
    startedAt,
    lastActivityAt: startedAt + 5,
    finishedAt: startedAt + 5,
    status: 'done',
    exitCode,
    durationMs: 5000,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    costUsd: 0.001,
    turns: 1,
    model: null,
    navJobId: id,
    navSessionId: null,
    verdict: undefined,
    logPruned: false,
    parentJobId,
    parentLabel: parentJobId ? 'release' : null,
    _jobIds: [id],
  };
}

describe('groupReleaseChildren', () => {
  it('returns empty for no entries', () => {
    expect(groupReleaseChildren([])).toEqual([]);
  });

  it('nests a release under its triggering run when parentJobId matches', () => {
    const run = makeStepEntry('run-1', 'run', 1000);
    run.kind = 'run';
    run.bucket = 'run';
    const release = makeReleaseEntry('rel-1', 1010, 1020, 'run-1');
    const out = groupReleaseChildren([run, release]);
    // The run is the only top-level entry; the release is nested under it.
    expect(out).toHaveLength(1);
    const runEntry = out.find(e => e.kind === 'run');
    expect(runEntry).toBeTruthy();
    const runHasReleaseChild = runEntry?.chainedChildren?.some(c => c.kind === 'release') ?? false;
    expect(runHasReleaseChild).toBe(true);
  });

  it('pipeline child steps are grouped under their containing release', () => {
    const release = makeReleaseEntry('rel-1', 1000, null);
    const test = makeStepEntry('test-1', 'test', 1005, 'rel-1');
    const review = makeStepEntry('review-1', 'review', 1015, 'rel-1');
    const out = groupReleaseChildren([release, test, review]);
    const rel = out.find(e => e.navJobId === 'rel-1');
    expect(rel?.children).toHaveLength(2);
    expect(rel?.children?.map(c => c.kind).sort()).toEqual(['review', 'test']);
  });

  it('a single orphaned pipeline step is NOT clustered into a vgroup', () => {
    const test = makeStepEntry('lone-test', 'test', 1000);
    const out = groupReleaseChildren([test]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('test');
    expect(out[0].key).not.toMatch(/^vgroup:/);
  });

  it('two orphaned pipeline steps within 30 min are clustered into a virtual release row', () => {
    const test = makeStepEntry('t1', 'test', 1000);
    const review = makeStepEntry('r1', 'review', 1100); // 100s gap — within 30 min
    const out = groupReleaseChildren([test, review]);
    expect(out).toHaveLength(1);
    const vg = out[0];
    expect(vg.key).toMatch(/^vgroup:/);
    expect(vg.kind).toBe('release');
    expect(vg.title).toBe('Pipeline steps');
    expect(vg.children).toHaveLength(2);
  });

  it('two orphaned pipeline steps more than 30 min apart are NOT clustered', () => {
    const t1 = makeStepEntry('t1', 'test', 1000);
    // 31 min gap
    const r1 = makeStepEntry('r1', 'review', 1000 + 31 * 60);
    const out = groupReleaseChildren([t1, r1]);
    // Each is a single orphan → not clustered, stays as separate entries
    expect(out).toHaveLength(2);
    expect(out.every(e => !e.key.startsWith('vgroup:'))).toBe(true);
  });

  it('buildChain assigns direct parent→child edges via parent_job_id', () => {
    const release = makeReleaseEntry('rel-1', 1000, null);
    const test = makeStepEntry('test-1', 'test', 1005, 'rel-1');
    const review = makeStepEntry('review-1', 'review', 1015, 'test-1');
    const out = groupReleaseChildren([release, test, review]);
    const rel = out.find(e => e.navJobId === 'rel-1');
    // test should be the root of the chain, review a child of test
    const chain = rel?.chainedChildren;
    expect(chain).toHaveLength(1);
    expect(chain![0].kind).toBe('test');
    expect(chain![0].chainedChildren).toHaveLength(1);
    expect(chain![0].chainedChildren![0].kind).toBe('review');
  });

  it('vgroup aggregates tokens and cost from its children', () => {
    const t = makeStepEntry('t1', 'test', 1000);
    const r = makeStepEntry('r1', 'review', 1100);
    const out = groupReleaseChildren([t, r]);
    const vg = out[0];
    expect(vg.inputTokens).toBe(t.inputTokens + r.inputTokens);
    expect(vg.costUsd).toBeCloseTo(t.costUsd + r.costUsd);
  });
});
