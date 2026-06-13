// Unit tests for the formatting and bucketing utilities in project-runs/utils.ts
// These functions have no existing test coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatTokens,
  formatCost,
  dayLabel,
  parseJobCountsResponse,
} from '@/components/project-runs/formatting';
import {
  bucketOf,
} from '@/components/project-runs/kinds';
import {
  buildEntries,
  entryNeedsAttention,
  shouldShowStableKindTitle,
} from '@/components/project-runs/entries';
import { groupReleaseChildren } from '@/components/project-runs/release-groups';
import {
  buildReleaseSummary,
  flattenReleaseChildren,
  flattenPipelineSteps,
} from '@/components/project-runs/release-progress';
import type { Entry } from '@/components/project-runs/types';
import type { JobInfo } from '@/lib/client-api';

// ---------------------------------------------------------------------------
// parseJobCountsResponse
// ---------------------------------------------------------------------------
describe('parseJobCountsResponse', () => {
  it('rejects non-count JSON from unrelated endpoints', () => {
    expect(parseJobCountsResponse({ settings: { github_board_sync_enabled: 'false' } })).toBeNull();
  });

  it('defaults missing nested counters for partial count responses', () => {
    expect(parseJobCountsResponse({
      total: 12,
      byKind: { review: 2, bad: 'nope' },
    })).toEqual({
      total: 12,
      byKind: { review: 2 },
      byStatus: { running: 0, done: 0, aborted: 0, failed: 0 },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
      cost: { total: 0, monthToDate: 0 },
    });
  });
});

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
// entryNeedsAttention
// ---------------------------------------------------------------------------
describe('entryNeedsAttention', () => {
  it('treats NEEDS ATTENTION reviews as attention even with exitCode 0', () => {
    expect(entryNeedsAttention(makeEntry({ kind: 'review', exitCode: 0, verdict: 'NEEDS ATTENTION' }))).toBe(true);
  });

  it('treats DO NOT SHIP reviews as attention even with exitCode 0', () => {
    expect(entryNeedsAttention(makeEntry({ kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' }))).toBe(true);
  });

  it('treats review rows with no parsed verdict as attention', () => {
    expect(entryNeedsAttention(makeEntry({ kind: 'review', exitCode: 0, verdict: undefined }))).toBe(true);
  });

  it('does not flag LGTM reviews as attention', () => {
    expect(entryNeedsAttention(makeEntry({ kind: 'review', exitCode: 0, verdict: 'LGTM' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildReleaseSummary
// ---------------------------------------------------------------------------
function makeEntry(partial: {
  kind: string;
  status?: 'running' | 'done';
  exitCode?: number | null;
  verdict?: string;
  startedAt?: number;
}): Entry {
  return {
    key: `job:${partial.kind}`,
    project: 'proj',
    kind: partial.kind,
    bucket: partial.kind as Entry['bucket'],
    title: partial.kind,
    subtitle: null,
    startedAt: partial.startedAt ?? 1000,
    lastActivityAt: partial.startedAt ?? 1000,
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
    failureLabel: null,
    logPruned: false,
    workSummary: null,
    modifiedFiles: null,
    parentJobId: null,
    parentLabel: null,
  } as Entry;
}

describe('buildReleaseSummary', () => {
  it('returns (no steps) for empty children', () => {
    expect(buildReleaseSummary([])).toBe('(no steps)');
  });

  it('explains a failed release that did not start a step', () => {
    const release = makeEntry({ kind: 'release', exitCode: 1 });
    expect(buildReleaseSummary([], release)).toBe('release blocked before first step');
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
    const kids = [makeEntry({ kind: 'push', exitCode: 1 })];
    expect(buildReleaseSummary(kids)).toBe('push ✗1');
  });

  it('marks a failed test without a fix as pending remediation', () => {
    const kids = [makeEntry({ kind: 'test', exitCode: 1 })];
    expect(buildReleaseSummary(kids)).toBe('test ✗1 · fix pending');
  });

  it('does not mark a failed test as pending once a fix has started', () => {
    const kids = [
      makeEntry({ kind: 'test', exitCode: 1, startedAt: 1000 }),
      makeEntry({ kind: 'fix', status: 'running', exitCode: null, startedAt: 1010 }),
    ];
    expect(buildReleaseSummary(kids)).toBe('test ✗1 · fix …');
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

function makeReleaseEntry(
  id: string,
  startedAt: number,
  finishedAt: number | null = startedAt + 10,
  parentJobId: string | null = null,
  exitCode = 0,
): Entry {
  return {
    key: `job:${id}`,
    project: 'proj',
    kind: 'release',
    bucket: 'release',
    title: 'Release pipeline',
    subtitle: null,
    startedAt,
    lastActivityAt: finishedAt ?? startedAt,
    finishedAt,
    status: finishedAt !== null ? 'done' : 'running',
    exitCode: finishedAt !== null ? exitCode : null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 1,
    model: null,
    navJobId: id,
    navSessionId: null,
    releaseId: null,
    verdict: undefined,
    failureLabel: null,
    releaseOutcome: null,
    logPruned: false,
    parentJobId,
    parentLabel: parentJobId ? 'run' : null,
    workSummary: null,
    modifiedFiles: null,
    _jobIds: [id],
  };
}

function makeStepEntry(id: string, kind: string, startedAt: number, parentJobId: string | null = null, exitCode = 0): Entry {
  return {
    key: `job:${id}`,
    project: 'proj',
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
    releaseId: null,
    verdict: undefined,
    failureLabel: null,
    logPruned: false,
    parentJobId,
    parentLabel: parentJobId ? 'release' : null,
    workSummary: null,
    modifiedFiles: null,
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

  it('surfaces a nested release failure on the triggering run row', () => {
    const run = makeStepEntry('agent-1', 'agent:frontend', 1000, null, 0);
    run.bucket = 'agent';
    run.title = 'frontend';
    const release = makeReleaseEntry('rel-1', 1010, 1050, 'agent-1', 1);
    const test = makeStepEntry('test-1', 'test', 1020, 'rel-1', 1);
    const out = groupReleaseChildren([run, release, test]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('agent:frontend');
    expect(out[0].exitCode).toBe(0);
    expect(out[0].releaseOutcome).toEqual({
      status: 'failed',
      label: 'release failed',
      releaseJobId: 'rel-1',
    });
    expect(out[0].finishedAt).toBe(1050);
    expect(out[0].chainedChildren?.[0].children?.[0].kind).toBe('test');
  });

  it('uses the newest nested release outcome on the triggering run row', () => {
    const run = makeStepEntry('run-1', 'run', 1000, null, 0);
    run.bucket = 'run';
    run.title = 'ship it';
    const oldRelease = makeReleaseEntry('rel-old', 1010, 1030, 'run-1', 0);
    const newRelease = makeReleaseEntry('rel-new', 1100, null, 'run-1', 0);

    const out = groupReleaseChildren([run, oldRelease, newRelease]);

    expect(out).toHaveLength(1);
    expect(out[0].releaseOutcome).toEqual({
      status: 'running',
      label: 'release running',
      releaseJobId: 'rel-new',
    });
    expect(out[0].chainedChildren?.map((entry) => entry.navJobId)).toEqual(['rel-new', 'rel-old']);
  });

  it('labels a nested failed release with no steps as blocked instead of a raw exit code', () => {
    const run = makeStepEntry('agent-1', 'agent:improve', 1000, null, 0);
    run.bucket = 'agent';
    run.title = 'improve';
    const release = makeReleaseEntry('rel-1', 1010, 1011, 'agent-1', 1);
    const out = groupReleaseChildren([run, release]);
    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(0);
    expect(out[0].failureLabel).toBeNull();
    expect(out[0].releaseOutcome).toEqual({
      status: 'blocked',
      label: 'release blocked',
      releaseJobId: 'rel-1',
    });
    expect(out[0].chainedChildren?.[0].failureLabel).toBe('release blocked');
    expect(buildReleaseSummary(out[0].chainedChildren?.[0].children ?? [], out[0].chainedChildren?.[0])).toBe('release blocked before first step');
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

  it.each([
    ['test', undefined],
    ['review', 'NEEDS ATTENTION'],
    ['commit', undefined],
  ] as const)('keeps a running release live while a failed %s step can still enter a fix loop', (kind, verdict) => {
    const release = makeReleaseEntry('rel-1', 1000, null);
    const child = makeStepEntry(`${kind}-1`, kind, 1010, 'rel-1', kind === 'review' ? 0 : 1);
    child.verdict = verdict;

    const out = groupReleaseChildren([release, child]);
    const rel = out.find(e => e.navJobId === 'rel-1');

    expect(rel?.status).toBe('running');
    expect(rel?.finishedAt).toBeNull();
    expect(rel?.exitCode).toBeNull();
    expect(rel?.failureLabel).toBeNull();
  });

  it('still cancels a running release when the latest child is cancelled', () => {
    const release = makeReleaseEntry('rel-1', 1000, null);
    const child = makeStepEntry('commit-1', 'commit', 1010, 'rel-1', -3);
    child.status = 'aborted';

    const out = groupReleaseChildren([release, child]);
    const rel = out.find(e => e.navJobId === 'rel-1');

    expect(rel?.status).toBe('aborted');
    expect(rel?.exitCode).toBe(-3);
    expect(rel?.failureLabel).toBe('release cancelled');
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

  it('an orphaned pipeline cluster ending in abort stays terminal and cancelled', () => {
    const test = makeStepEntry('t1', 'test', 1000);
    const review = makeStepEntry('r1', 'review', 1100);
    review.status = 'aborted';
    review.exitCode = -3;
    const out = groupReleaseChildren([test, review]);
    const vg = out[0];
    expect(vg.status).toBe('aborted');
    expect(vg.exitCode).toBe(-3);
    expect(vg.failureLabel).toBe('pipeline cancelled');
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

// ---------------------------------------------------------------------------
// flattenPipelineSteps
// ---------------------------------------------------------------------------

function makeFlatEntry(id: string, kind: string, chainedChildren?: Entry[]): Entry {
  return {
    ...makeStepEntry(id, kind, 1000),
    chainedChildren,
  };
}

describe('flattenPipelineSteps', () => {
  it('returns empty list for no roots', () => {
    expect(flattenPipelineSteps([], 0)).toEqual([]);
  });

  it('assigns baseDepth to non-fix steps', () => {
    const test = makeFlatEntry('test-1', 'test');
    const review = makeFlatEntry('review-1', 'review');
    const result = flattenPipelineSteps([test, review], 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ entry: test, depth: 1 });
    expect(result[1]).toEqual({ entry: review, depth: 1 });
  });

  it('assigns baseDepth+1 to fix steps', () => {
    const fix = makeFlatEntry('fix-1', 'fix');
    const result = flattenPipelineSteps([fix], 2);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(3);
  });

  // fix-push collapsed into fix; depth assignment is exercised by the fix
  // depth tests above. Keeping a placeholder here so this anchor in the
  // test file remains discoverable.

  it('flattens chained children back to baseDepth after a fix', () => {
    // test → fix → review (review should resume at baseDepth, not fix depth)
    const review = makeFlatEntry('review-1', 'review');
    const fix = makeFlatEntry('fix-1', 'fix', [review]);
    const test = makeFlatEntry('test-1', 'test', [fix]);
    const result = flattenPipelineSteps([test], 1);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ entry: test, depth: 1 });   // test at baseDepth
    expect(result[1]).toEqual({ entry: fix, depth: 2 });    // fix at baseDepth+1
    expect(result[2]).toEqual({ entry: review, depth: 1 }); // review back at baseDepth
  });

  it('handles multiple roots with mixed fix and non-fix kinds', () => {
    const test = makeFlatEntry('test-1', 'test');
    const fix = makeFlatEntry('fix-1', 'fix');
    const commit = makeFlatEntry('commit-1', 'commit');
    const result = flattenPipelineSteps([test, fix, commit], 0);
    expect(result[0].depth).toBe(0);  // test
    expect(result[1].depth).toBe(1);  // fix
    expect(result[2].depth).toBe(0);  // commit
  });

  it('respects a non-zero baseDepth for all depth calculations', () => {
    const fix = makeFlatEntry('fix-1', 'fix');
    const push = makeFlatEntry('push-1', 'push');
    const result = flattenPipelineSteps([fix, push], 3);
    expect(result[0].depth).toBe(4);  // fix at baseDepth+1 = 4
    expect(result[1].depth).toBe(3);  // push at baseDepth = 3
  });
});

describe('flattenReleaseChildren', () => {
  it('orders merged review sessions by latest activity while keeping fixes indented', () => {
    const test = {
      ...makeStepEntry('test-1', 'test', 1000),
      startedAt: 1000,
      lastActivityAt: 1010,
      finishedAt: 1010,
    };
    const review = {
      ...makeStepEntry('review-1', 'review', 1020),
      startedAt: 1020,
      lastActivityAt: 1230,
      finishedAt: 1240,
      turns: 2,
      _jobIds: ['review-1', 'review-2'],
    };
    const fix = {
      ...makeStepEntry('fix-1', 'fix', 1180),
      startedAt: 1180,
      lastActivityAt: 1200,
      finishedAt: 1200,
      parentJobId: 'review-1',
    };

    const result = flattenReleaseChildren([test, review, fix], 1);

    expect(result).toEqual([
      { entry: test, depth: 1 },
      { entry: fix, depth: 2 },
      { entry: review, depth: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// titleForJob (exercised through buildEntries) — pipeline-step rows describe
// their outcome in the title slot instead of a static "Test run"/"Code review".
// ---------------------------------------------------------------------------
describe('buildEntries — pipeline-step titles', () => {
  let n = 0;
  function makeJob(partial: Partial<JobInfo> & { kind: string }): JobInfo {
    n += 1;
    return {
      id: `job-${n}`,
      project: 'p',
      prompt: null,
      pid: 1,
      log_path: '',
      status: 'done',
      exit_code: 0,
      started_at: 1000 + n,
      finished_at: 2000 + n,
      seen: true,
      ...partial,
    };
  }
  const titleOf = (partial: Partial<JobInfo> & { kind: string }): string =>
    buildEntries([makeJob(partial)])[0].title;

  it('shows pass/fail for a completed test from its exit code', () => {
    expect(titleOf({ kind: 'test', exit_code: 0 })).toBe('✅ Tests passed');
    expect(titleOf({ kind: 'test', exit_code: 1 })).toBe('❌ Tests failed');
  });

  it('marks a cancelled or running test distinctly', () => {
    expect(titleOf({ kind: 'test', status: 'aborted', exit_code: -3 })).toBe('Tests cancelled');
    expect(titleOf({ kind: 'test', status: 'running', exit_code: null, finished_at: null })).toBe('Running tests…');
  });

  it('prefers a captured work_summary over the derived test status', () => {
    expect(titleOf({ kind: 'test', exit_code: 0, work_summary: '142 tests, 0 failures' }))
      .toBe('142 tests, 0 failures');
  });

  it('uses the review verdict when no summary was captured', () => {
    expect(titleOf({ kind: 'review', verdict: 'LGTM' })).toBe('✓ LGTM — looks good to ship');
    expect(titleOf({ kind: 'review', verdict: 'NEEDS ATTENTION' })).toBe('⚠ Needs attention');
    expect(titleOf({ kind: 'review', verdict: 'DO NOT SHIP' })).toBe('✗ Do not ship');
  });

  it('prefers the review finding summary over the verdict', () => {
    expect(titleOf({ kind: 'review', verdict: 'NEEDS ATTENTION', work_summary: 'Address race in poller' }))
      .toBe('Address race in poller');
  });

  it('surfaces the commit/push/fix work_summary in the title', () => {
    expect(titleOf({ kind: 'commit', work_summary: 'fix(api): handle null (abc1234)' }))
      .toBe('fix(api): handle null (abc1234)');
    expect(titleOf({ kind: 'push', work_summary: 'Pushed as abc1234' })).toBe('Pushed as abc1234');
    expect(titleOf({ kind: 'fix', work_summary: 'Lowercased contract address before persist' }))
      .toBe('Lowercased contract address before persist');
  });

  it('falls back to the kind label for steps with no captured summary', () => {
    expect(titleOf({ kind: 'commit' })).toBe('Commit');
    expect(titleOf({ kind: 'push' })).toBe('Push');
    expect(titleOf({ kind: 'fix' })).toBe('Auto-fix');
  });

  it('uses stable titles for pr-wait and soak so row prefixes do not duplicate them', () => {
    expect(titleOf({ kind: 'pr-wait' })).toBe('PR wait');
    expect(titleOf({ kind: 'soak' })).toBe('Soak');
  });

  it('does not request a stable prefix for mark-dod detail titles', () => {
    const [entry] = buildEntries([makeJob({
      kind: 'mark-dod',
      context_meta: JSON.stringify({ total: 3, verified: 2 }),
    })]);

    expect(entry.title).toBe('Mark DoD — 2/3 ✓, 1 unverified');
    expect(shouldShowStableKindTitle(entry)).toBe(false);
  });

  it('does not request a stable prefix for synthetic pipeline-step release rows', () => {
    const grouped = groupReleaseChildren(buildEntries([
      makeJob({ id: 'test-1', kind: 'test', started_at: 1000, finished_at: 1010 }),
      makeJob({ id: 'push-1', kind: 'push', started_at: 1020, finished_at: 1030, exit_code: 1 }),
    ]));

    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe('Pipeline steps');
    expect(shouldShowStableKindTitle(grouped[0])).toBe(false);
  });

  it('refreshes a merged review title when a later turn captures a summary', () => {
    const entries = buildEntries([
      makeJob({
        kind: 'review',
        session_id: 'sess-review',
        status: 'running',
        exit_code: null,
        finished_at: null,
      }),
      makeJob({
        kind: 'review',
        session_id: 'sess-review',
        status: 'done',
        exit_code: 0,
        verdict: 'NEEDS ATTENTION',
        work_summary: 'Address race in poller',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Address race in poller');
    expect(entries[0].verdict).toBe('NEEDS ATTENTION');
  });

  it('refreshes a merged fix title when a later turn captures a summary', () => {
    const entries = buildEntries([
      makeJob({
        kind: 'fix',
        session_id: 'sess-fix',
        status: 'running',
        exit_code: null,
        finished_at: null,
      }),
      makeJob({
        kind: 'fix',
        session_id: 'sess-fix',
        status: 'done',
        exit_code: 0,
        work_summary: 'Lowercased contract address before persist',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Lowercased contract address before persist');
  });

  it('keeps the agent task name and run prompt as the title', () => {
    expect(titleOf({ kind: 'agent:improve-frontend', work_summary: 'Fixed a telemetry dead-end' }))
      .toBe('improve-frontend');
    expect(titleOf({ kind: 'run', user_prompt: 'add a dark mode toggle' })).toBe('add a dark mode toggle');
  });
});
