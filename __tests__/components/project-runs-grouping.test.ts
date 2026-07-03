// Unit tests for the release-grouping helper and buildEntries in ProjectRunsTab.
//
// Release grouping: current rows use release_id; legacy rows without release_id
// fall back to the release's [startedAt, finishedAt ?? ∞] window.
//
// The component rendering is React — we only import the pure helpers so
// Node-only vitest can run this.
import { describe, it, expect } from 'vitest';
import { buildEntries } from '@/components/project-runs/entries';
import { groupReleaseChildren } from '@/components/project-runs/release-groups';
import type { JobInfo } from '@/lib/client-api';

// Loose entry shape — the real Entry interface lives in ProjectRunsTab but
// isn't exported. We build enough fields to satisfy the grouping logic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = any;

function makeEntry(partial: {
  id: string;
  kind: string;
  startedAt: number;
  finishedAt?: number | null;
  status?: 'running' | 'done';
  exitCode?: number | null;
  project?: string;
  releaseId?: string | null;
}): AnyEntry {
  return {
    key: `job:${partial.id}`,
    project: partial.project ?? 'proj',
    kind: partial.kind,
    bucket: partial.kind === 'release' ? 'release' : (partial.kind as string),
    title: partial.kind,
    subtitle: null,
    startedAt: partial.startedAt,
    lastActivityAt: partial.startedAt,
    finishedAt: partial.finishedAt ?? null,
    status: partial.status ?? 'done',
    exitCode: partial.exitCode ?? 0,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 1,
    model: null,
    navJobId: partial.id,
    navSessionId: null,
    releaseId: partial.releaseId ?? null,
    logPruned: false,
  };
}

describe('groupReleaseChildren', () => {
  it('folds test/review/commit/push under a matching release', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 200 }),
      makeEntry({ id: 't', kind: 'test', startedAt: 110, finishedAt: 115 }),
      makeEntry({ id: 'r', kind: 'review', startedAt: 120, finishedAt: 140 }),
      makeEntry({ id: 'c', kind: 'commit', startedAt: 150, finishedAt: 160 }),
      makeEntry({ id: 'p', kind: 'push', startedAt: 170, finishedAt: 180 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('release');
    expect(out[0].children).toBeDefined();
    expect(out[0].children!.map((c) => c.kind)).toEqual(['test', 'review', 'commit', 'push']);
  });

  it('leaves pipeline jobs outside any release window as flat entries', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 200 }),
      makeEntry({ id: 'stray', kind: 'test', startedAt: 300, finishedAt: 310 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(2);
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain('release');
    expect(kinds).toContain('test');
  });

  it('does not group non-pipeline kinds (run / agent / fix-ci) even inside a release window', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 200 }),
      makeEntry({ id: 'chat', kind: 'run', startedAt: 150, finishedAt: 160 }),
      makeEntry({ id: 'fx', kind: 'fix-ci', startedAt: 150, finishedAt: 160 }),
    ];
    const out = groupReleaseChildren(entries);
    // All three entries remain visible at the top level
    expect(out).toHaveLength(3);
    const rel = out.find((e) => e.kind === 'release')!;
    expect(rel.children).toEqual([]);
  });

  it('treats a running release (finishedAt=null) as open-ended', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: null, status: 'running' }),
      makeEntry({ id: 't', kind: 'test', startedAt: 999_999, finishedAt: 1_000_000 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].children!.map((c) => c.kind)).toEqual(['test']);
  });

  it('assigns a child to the latest-starting release when windows overlap', () => {
    // Shouldn't happen in practice (pipeline_locks), but the tiebreaker
    // matters if the DB has a corrupt pair.
    const entries = [
      makeEntry({ id: 'oldRel', kind: 'release', startedAt: 100, finishedAt: 500 }),
      makeEntry({ id: 'newRel', kind: 'release', startedAt: 200, finishedAt: 400 }),
      makeEntry({ id: 'c', kind: 'commit', startedAt: 250, finishedAt: 260 }),
    ];
    const out = groupReleaseChildren(entries);
    const newRel = out.find((e) => e.navJobId === 'newRel')!;
    const oldRel = out.find((e) => e.navJobId === 'oldRel')!;
    expect(newRel.children!.map((c) => c.navJobId)).toContain('c');
    expect(oldRel.children!.map((c) => c.navJobId)).not.toContain('c');
  });

  it('uses releaseId before timestamp windows when release windows overlap', () => {
    const entries = [
      makeEntry({ id: 'rel-a', kind: 'release', startedAt: 100, finishedAt: 500 }),
      makeEntry({ id: 'rel-b', kind: 'release', startedAt: 200, finishedAt: 400 }),
      makeEntry({ id: 'test-a', kind: 'test', startedAt: 250, finishedAt: 260, releaseId: 'rel-a' }),
      makeEntry({ id: 'review-b', kind: 'review', startedAt: 260, finishedAt: 270, releaseId: 'rel-b' }),
    ];

    const out = groupReleaseChildren(entries);

    const relA = out.find((e) => e.navJobId === 'rel-a')!;
    const relB = out.find((e) => e.navJobId === 'rel-b')!;
    expect(relA.children!.map((c) => c.navJobId)).toEqual(['test-a']);
    expect(relB.children!.map((c) => c.navJobId)).toEqual(['review-b']);
  });

  it('does not fold pipeline jobs into a release from another project', () => {
    const entries = [
      makeEntry({ id: 'rel-a', project: 'a', kind: 'release', startedAt: 100, finishedAt: 200 }),
      makeEntry({ id: 'test-b', project: 'b', kind: 'test', startedAt: 120, finishedAt: 130 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(2);
    const rel = out.find((e) => e.navJobId === 'rel-a')!;
    const test = out.find((e) => e.navJobId === 'test-b')!;
    expect(rel.children).toEqual([]);
    expect(test.kind).toBe('test');
  });

  it('clusters orphaned pipeline steps even when there are no release entries', () => {
    // Previously this was a no-op; now nearby pipeline steps get clustered.
    const entries = [
      makeEntry({ id: 't', kind: 'test', startedAt: 100 }),
      makeEntry({ id: 'r', kind: 'review', startedAt: 120 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('release');
    expect(out[0].children).toHaveLength(2);
  });

  it('folds mark-dod and fix as pipeline children', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 300 }),
      makeEntry({ id: 'md', kind: 'mark-dod', startedAt: 150 }),
      makeEntry({ id: 'fx', kind: 'fix', startedAt: 200 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].children!.map((c) => c.kind).sort()).toEqual(['fix', 'mark-dod']);
  });

  it('clusters orphaned pipeline steps within 30 min into a virtual release group', () => {
    // No release job — three pipeline steps close together should become one virtual group.
    const entries = [
      makeEntry({ id: 't', kind: 'test', startedAt: 1000, finishedAt: 1005 }),
      makeEntry({ id: 'r', kind: 'review', startedAt: 1010, finishedAt: 1020 }),
      makeEntry({ id: 'p', kind: 'push', startedAt: 1030, finishedAt: 1040 }),
    ];
    const out = groupReleaseChildren(entries);
    // Expect one virtual group (kind=release) with 3 children
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('release');
    expect(out[0].title).toBe('Pipeline steps');
    expect(out[0].children).toHaveLength(3);
    expect(out[0].children!.map((c) => c.kind)).toEqual(['test', 'review', 'push']);
  });

  it('clusters orphaned pipeline steps separately per project', () => {
    const entries = [
      makeEntry({ id: 'a-t', project: 'a', kind: 'test', startedAt: 1000, finishedAt: 1005 }),
      makeEntry({ id: 'a-r', project: 'a', kind: 'review', startedAt: 1010, finishedAt: 1020 }),
      makeEntry({ id: 'b-t', project: 'b', kind: 'test', startedAt: 1000, finishedAt: 1005 }),
      makeEntry({ id: 'b-r', project: 'b', kind: 'review', startedAt: 1010, finishedAt: 1020 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.project).sort()).toEqual(['a', 'b']);
    expect(out.every((e) => e.children?.length === 2)).toBe(true);
  });

  it('clustered chain that recovers from a failed step reports green (terminal step exit 0)', () => {
    // test fails → fix succeeds → test passes → push succeeds. The pipeline
    // recovered: virtual group should report exit 0, not red.
    const entries = [
      makeEntry({ id: 't1', kind: 'test', startedAt: 1000, finishedAt: 1010, exitCode: 1 }),
      makeEntry({ id: 'fix1', kind: 'fix', startedAt: 1020, finishedAt: 1080, exitCode: 0 }),
      makeEntry({ id: 't2', kind: 'test', startedAt: 1090, finishedAt: 1100, exitCode: 0 }),
      makeEntry({ id: 'p1', kind: 'push', startedAt: 1110, finishedAt: 1115, exitCode: 1 }),
      makeEntry({ id: 'fp', kind: 'fix', startedAt: 1120, finishedAt: 1180, exitCode: 0 }),
      makeEntry({ id: 'p2', kind: 'push', startedAt: 1190, finishedAt: 1200, exitCode: 0 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('release');
    expect(out[0].exitCode).toBe(0);
    expect(out[0].failureLabel).toBeNull();
  });

  it('clustered chain that ends on a failed terminal step reports red', () => {
    // push fails and no recovery — the virtual group is genuinely failed.
    const entries = [
      makeEntry({ id: 't', kind: 'test', startedAt: 1000, finishedAt: 1010, exitCode: 0 }),
      makeEntry({ id: 'p', kind: 'push', startedAt: 1020, finishedAt: 1030, exitCode: 1 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('pipeline failed');
  });

  it('cluster ending on a successful fix still reports attention until follow-up runs', () => {
    const entries = [
      makeEntry({ id: 't', kind: 'test', startedAt: 1000, finishedAt: 1010, exitCode: 1 }),
      makeEntry({ id: 'fix', kind: 'fix', startedAt: 1020, finishedAt: 1080, exitCode: 0 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('follow-up pending');
  });

  it('cluster ending on a successful push-fix still reports attention until push reruns', () => {
    const entries = [
      makeEntry({ id: 'push', kind: 'push', startedAt: 1000, finishedAt: 1010, exitCode: 1 }),
      makeEntry({ id: 'fix-push', kind: 'fix', startedAt: 1020, finishedAt: 1080, exitCode: 0 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('follow-up pending');
  });

  it('cluster ending on a review with NEEDS ATTENTION stays red until a later LGTM review', () => {
    const attentionReview = {
      ...makeEntry({ id: 'review-1', kind: 'review', startedAt: 1000, finishedAt: 1010, exitCode: 0 }),
      verdict: 'NEEDS ATTENTION',
    };
    const out = groupReleaseChildren([
      makeEntry({ id: 'test-1', kind: 'test', startedAt: 900, finishedAt: 950, exitCode: 0 }),
      attentionReview,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('review needs attention');

    const recovered = groupReleaseChildren([
      makeEntry({ id: 'test-1', kind: 'test', startedAt: 900, finishedAt: 950, exitCode: 0 }),
      attentionReview,
      { ...makeEntry({ id: 'fix-1', kind: 'fix', startedAt: 1020, finishedAt: 1030, exitCode: 0 }) },
      { ...makeEntry({ id: 'review-2', kind: 'review', startedAt: 1040, finishedAt: 1050, exitCode: 0 }), verdict: 'LGTM' },
    ]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].exitCode).toBe(0);
    expect(recovered[0].failureLabel).toBeNull();
  });

  it('cluster ending on a successful mark-dod keeps the pipeline actionable instead of green', () => {
    const out = groupReleaseChildren([
      makeEntry({ id: 'push-1', kind: 'push', startedAt: 1000, finishedAt: 1010, exitCode: 1 }),
      makeEntry({ id: 'dod-1', kind: 'mark-dod', startedAt: 1020, finishedAt: 1030, exitCode: 0 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('follow-up pending');
  });

  it('cluster ending on a successful mark-dod after LGTM still reports follow-up pending', () => {
    const out = groupReleaseChildren([
      { ...makeEntry({ id: 'review-lgtm', kind: 'review', startedAt: 1000, finishedAt: 1010, exitCode: 0 }), verdict: 'LGTM' },
      makeEntry({ id: 'dod-1', kind: 'mark-dod', startedAt: 1020, finishedAt: 1030, exitCode: 0 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].exitCode).toBe(1);
    expect(out[0].failureLabel).toBe('follow-up pending');
  });

  it('does not cluster orphaned pipeline steps separated by more than 30 min', () => {
    const GAP = 31 * 60; // 31 minutes
    const entries = [
      makeEntry({ id: 'r1', kind: 'review', startedAt: 1000, finishedAt: 1010 }),
      makeEntry({ id: 'r2', kind: 'review', startedAt: 1000 + GAP, finishedAt: 1000 + GAP + 10 }),
    ];
    const out = groupReleaseChildren(entries);
    // Two separate clusters → two individual entries (< 2 per cluster)
    expect(out).toHaveLength(2);
    expect(out.every(e => e.kind === 'review')).toBe(true);
  });

  it('non-pipeline orphans are never clustered even within 30 min', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 1000, finishedAt: 2000 }),
      makeEntry({ id: 'run', kind: 'run', startedAt: 1100, finishedAt: 1200 }),
      makeEntry({ id: 'rev', kind: 'review', startedAt: 3000, finishedAt: 3010 }),
      makeEntry({ id: 'push', kind: 'push', startedAt: 3020, finishedAt: 3025 }),
    ];
    const out = groupReleaseChildren(entries);
    // release (empty children), run (non-pipeline stays flat), virtual group (review+push)
    expect(out).toHaveLength(3);
    const kinds = out.map(e => e.kind).sort();
    expect(kinds).toEqual(['release', 'release', 'run']);
  });

  it('nests a release under its parent agent when parentJobId matches', () => {
    const entries = [
      { ...makeEntry({ id: 'agent1', kind: 'agent:test-e2e', startedAt: 100, finishedAt: 500 }), parentJobId: null, _jobIds: ['agent1'] },
      { ...makeEntry({ id: 'rel', kind: 'release', startedAt: 120, finishedAt: 480 }), parentJobId: 'agent1', _jobIds: ['rel'] },
      makeEntry({ id: 'r', kind: 'review', startedAt: 130, finishedAt: 200 }),
      makeEntry({ id: 'c', kind: 'commit', startedAt: 210, finishedAt: 220 }),
    ];
    const out = groupReleaseChildren(entries);
    // Only the agent row is top-level; the release is nested inside it.
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('agent:test-e2e');
    expect(out[0].chainedChildren).toHaveLength(1);
    expect(out[0].chainedChildren![0].kind).toBe('release');
    // The release still has its pipeline children.
    expect(out[0].chainedChildren![0].children!.map((c: AnyEntry) => c.kind)).toEqual(['review', 'commit']);
  });

  it('surfaces a failed owned release\'s stop reason on the parent agent outcome', () => {
    // Continue-release from an agent row: the agent succeeds (exit 0) but the
    // release-after-run it owns fails. The row goes red because of that owned
    // release, so its stop reason must ride along on the outcome — otherwise
    // the operator sees "failed" with no cause (the reported bug).
    const reason = 'review startup failed: Jobs are paused globally. Turn the switch back on in Settings to start a review.';
    const entries = [
      { ...makeEntry({ id: 'agent1', kind: 'agent:issue-cruncher', startedAt: 100, finishedAt: 500, exitCode: 0 }), parentJobId: null, _jobIds: ['agent1'] },
      { ...makeEntry({ id: 'rel', kind: 'release', startedAt: 120, finishedAt: 480, exitCode: 1 }), parentJobId: 'agent1', _jobIds: ['rel'], releaseStopReason: reason },
      makeEntry({ id: 'r', kind: 'review', startedAt: 130, finishedAt: 200, exitCode: 1 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out).toHaveLength(1);
    const agent = out[0];
    expect(agent.kind).toBe('agent:issue-cruncher');
    expect(agent.releaseOutcome!.status).toBe('failed');
    expect(agent.releaseOutcome!.reason).toBe(reason);
  });

  it('surfaces a blocked owned release\'s stop reason (no children ran) on the parent agent outcome', () => {
    const reason = 'review startup failed: Jobs are paused globally. Turn the switch back on in Settings to start a review.';
    const entries = [
      { ...makeEntry({ id: 'agent1', kind: 'agent:issue-cruncher', startedAt: 100, finishedAt: 500, exitCode: 0 }), parentJobId: null, _jobIds: ['agent1'] },
      { ...makeEntry({ id: 'rel', kind: 'release', startedAt: 120, finishedAt: 480, exitCode: 1 }), parentJobId: 'agent1', _jobIds: ['rel'], releaseStopReason: reason },
    ];
    const out = groupReleaseChildren(entries);
    const agent = out[0];
    expect(agent.releaseOutcome!.status).toBe('blocked');
    expect(agent.releaseOutcome!.reason).toBe(reason);
  });

  it('does not attach a reason to a successful owned release outcome', () => {
    const entries = [
      { ...makeEntry({ id: 'agent1', kind: 'agent:issue-cruncher', startedAt: 100, finishedAt: 500, exitCode: 0 }), parentJobId: null, _jobIds: ['agent1'] },
      { ...makeEntry({ id: 'rel', kind: 'release', startedAt: 120, finishedAt: 480, exitCode: 0 }), parentJobId: 'agent1', _jobIds: ['rel'] },
      makeEntry({ id: 'r', kind: 'review', startedAt: 130, finishedAt: 200, exitCode: 0 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out[0].releaseOutcome!.status).toBe('done');
    expect(out[0].releaseOutcome!.reason ?? null).toBeNull();
  });

  it('keeps a release top-level when its parentJobId does not match any agent/run', () => {
    const entries = [
      { ...makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 200 }), parentJobId: 'unknown-id', _jobIds: ['rel'] },
      makeEntry({ id: 'r', kind: 'review', startedAt: 110, finishedAt: 150 }),
    ];
    const out = groupReleaseChildren(entries);
    // Release stays at top level (no matching parent in top-level entries).
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('release');
  });

  it('sorts children by startedAt (pipeline order) regardless of input order', () => {
    const entries = [
      makeEntry({ id: 'rel', kind: 'release', startedAt: 100, finishedAt: 300 }),
      makeEntry({ id: 'p', kind: 'push', startedAt: 250 }),
      makeEntry({ id: 't', kind: 'test', startedAt: 110 }),
      makeEntry({ id: 'c', kind: 'commit', startedAt: 200 }),
      makeEntry({ id: 'r', kind: 'review', startedAt: 130 }),
    ];
    const out = groupReleaseChildren(entries);
    expect(out[0].children!.map((c) => c.kind)).toEqual(['test', 'review', 'commit', 'push']);
  });
});

function makeJobInfo(partial: Partial<JobInfo> & { id: string }): JobInfo {
  return {
    project: 'proj',
    kind: 'run',
    prompt: null,
    pid: 1234,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: 1000,
    finished_at: 2000,
    seen: true,
    ...partial,
  };
}

describe('buildEntries — null exitCode handling', () => {
  it('entry with exit_code=null and status=done has exitCode=null (not treated as failed)', () => {
    const jobs = [makeJobInfo({ id: 'j1', exit_code: null, status: 'done', finished_at: 2000 })];
    const [entry] = buildEntries(jobs);
    expect(entry.exitCode).toBeNull();
    // isFailed logic: not running AND exitCode !== null AND exitCode !== 0
    // With exitCode=null, isFailed must be false
    const isRunning = entry.status === 'running';
    const isFailed = !isRunning && entry.exitCode !== null && entry.exitCode !== 0;
    expect(isFailed).toBe(false);
  });

  it('entry with exit_code=0 is not failed', () => {
    const jobs = [makeJobInfo({ id: 'j2', exit_code: 0, status: 'done' })];
    const [entry] = buildEntries(jobs);
    const isFailed = entry.status !== 'running' && entry.exitCode !== null && entry.exitCode !== 0;
    expect(isFailed).toBe(false);
  });

  it('entry with exit_code=1 is failed', () => {
    const jobs = [makeJobInfo({ id: 'j3', exit_code: 1, status: 'done' })];
    const [entry] = buildEntries(jobs);
    const isFailed = entry.status !== 'running' && entry.exitCode !== null && entry.exitCode !== 0;
    expect(isFailed).toBe(true);
  });

  it('session-grouped entry takes exitCode from latest job in session', () => {
    const session = 'sess-abc';
    const jobs = [
      makeJobInfo({ id: 'j-first', exit_code: 0, status: 'done', session_id: session, started_at: 1000, finished_at: 2000 }),
      makeJobInfo({ id: 'j-latest', exit_code: 1, status: 'done', session_id: session, started_at: 3000, finished_at: 4000 }),
    ];
    const entries = buildEntries(jobs);
    expect(entries).toHaveLength(1);
    expect(entries[0].exitCode).toBe(1);
    expect(entries[0].turns).toBe(2);
  });
});
