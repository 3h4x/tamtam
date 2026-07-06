import { describe, it, expect, vi } from 'vitest';

// deriveInboxSignals is a pure function, but the module it lives in imports
// `@/lib/db` at the top level. Stub it so importing the module never touches a
// real Postgres pool — the pure derivation never calls into it.
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }));

import {
  deriveInboxSignals,
  countInboxSignals,
  rollupIsGreen,
  selectRepresentativePr,
  type InboxInput,
  type InboxJob,
} from '@/lib/workflows/inbox';
import type { Task } from '@/lib/shared/types';
import type { AutomationQueueItem } from '@/lib/workflows/automation-queue';

function makeTask(overrides: Partial<Task> & { project: string }): Task {
  return {
    id: overrides.project,
    job: null,
    priority: null,
    paused: false,
    path: `/tmp/${overrides.project}`,
    fires_at: '',
    sync: null,
    changes: 0,
    unpushed: 0,
    reviewed: null,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<InboxJob> & { project: string; kind: string }): InboxJob {
  return {
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    verdict: null,
    releaseStopReason: null,
    prWaitReason: null,
    prNumber: null,
    riskyFiles: null,
    releaseId: null,
    dodVerified: null,
    dodTotal: null,
    dodIssueNumber: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<InboxInput> = {}): InboxInput {
  return {
    tasks: [],
    jobs: [],
    automationQueue: [],
    openPrByProject: {},
    openPrNumbersByProject: {},
    pausedReasonByProject: {},
    nowSeconds: 10_000,
    ...overrides,
  };
}

describe('deriveInboxSignals', () => {
  it('flags a pr-wait that deferred auto-merge to a human (risky_diff) as needing manual merge', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 76 })],
        openPrByProject: { alpha: { number: 76, ciGreen: false, reviewDecision: null } },
        openPrNumbersByProject: { alpha: [76] },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_needs_manual_merge');
    expect(s).toMatchObject({
      type: 'pr_needs_manual_merge',
      severity: 'red',
      project: 'alpha',
      title: 'PR #76 needs manual merge',
      action: { kind: 'merge', label: 'Merge', prNumber: 76 },
    });
  });

  it('names the specific high-risk files and links the PR on a risky_diff signal', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha', github: 'https://github.com/o/alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 80, riskyFiles: ['package.json', '.github/workflows/deploy.yml'] })],
        openPrNumbersByProject: { alpha: [80] },
      }),
    )
    const s = signals.find((x) => x.type === 'pr_needs_manual_merge')
    expect(s?.detail).toContain('package.json')
    expect(s?.detail).toContain('.github/workflows/deploy.yml')
    expect(s?.externalUrl).toBe('https://github.com/o/alpha/pull/80')
  })

  it('surfaces the release DoD verification and linked issue on a manual-merge signal', () => {
    // Before deciding to merge a risky PR, the operator wants to see the issue
    // and what claude verified. The DoD result lives on the same release's
    // mark-dod job (verified/total + the issue it checked).
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [
          makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 80, releaseId: 'rel-1' }),
          makeJob({ project: 'alpha', kind: 'mark-dod', exitCode: 0, releaseId: 'rel-1', dodVerified: 6, dodTotal: 6, dodIssueNumber: 10 }),
        ],
        openPrNumbersByProject: { alpha: [80] },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_needs_manual_merge');
    expect(s?.detail).toContain('6/6');
    expect(s?.detail).toContain('#10');
  });

  it('omits the DoD detail when the release has no verified acceptance criteria', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [
          makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 81, releaseId: 'rel-2' }),
          makeJob({ project: 'alpha', kind: 'mark-dod', exitCode: 0, releaseId: 'rel-2', dodVerified: 0, dodTotal: 0, dodIssueNumber: null }),
        ],
        openPrNumbersByProject: { alpha: [81] },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_needs_manual_merge');
    expect(s?.detail).not.toContain('acceptance criteria');
  });

  it('clears the manual-merge signal once the deferred PR is no longer among the open PRs', () => {
    // Cache has other open PRs but not #76 → it was merged/closed → clear.
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 76 })],
        openPrNumbersByProject: { alpha: [55] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeUndefined();
  });

  it('still surfaces the manual-merge signal when the open-PR cache is empty (cannot confirm closure)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 76 })],
        openPrNumbersByProject: {},
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toMatchObject({ action: { prNumber: 76 } });
  });

  it('does not surface manual-merge once the pr-wait was stamped merged, even with an empty cache', () => {
    // An operator-driven merge (inbox / Issues-tab) stamps the outstanding
    // pr-wait `merged`. That must clear the HITL regardless of the open-PR
    // cache, which the merge path deletes — otherwise the resolving merge can
    // never clear the card it resolved. This is the escape hatch the merge
    // handler relies on; it must NOT be gated on the open-PR cache like the
    // fail-open case above.
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'merged', prNumber: 76 })],
        openPrNumbersByProject: {},
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeUndefined();
  });

  it('does not raise manual-merge for a self-healing pr-wait reason (checks_failed)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'checks_failed', prNumber: 76 })],
        openPrNumbersByProject: { alpha: [76] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeUndefined();
  });

  it('surfaces a red-CI pr-wait (ci_failed) as a HITL with a CI-specific message', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'ci_failed', prNumber: 78 })],
        openPrNumbersByProject: { alpha: [78] },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_needs_manual_merge');
    expect(s).toBeDefined();
    // Message must name CI as the blocker so the operator knows to fix the
    // failing check before merging — not the generic "needs a merge decision".
    expect(s?.detail).toMatch(/\bCI\b/);
    expect(s?.detail).toMatch(/fix/i);
  });

  it('flags a pr-wait that stopped on a merge conflict as needing manual merge (no silent stop)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'conflict', prNumber: 77 })],
        openPrNumbersByProject: { alpha: [77] },
      }),
    );
    // A merge conflict can't be cleared by a one-click "Merge" (it fails), so
    // the conflict terminal offers the resolve-conflicts action instead.
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toMatchObject({
      title: 'PR #77 needs manual merge',
      action: { kind: 'resolve-conflicts', prNumber: 77 },
    });
  });

  it('flags a pr-wait that finished non-zero with no recorded reason (never a silent stop)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: null, prNumber: 78 })],
        openPrNumbersByProject: { alpha: [78] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toMatchObject({ action: { prNumber: 78 } });
  });

  it('does not raise manual-merge for a benign terminal (pr_closed)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'pr_closed', prNumber: 79 })],
        openPrNumbersByProject: { alpha: [79] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeUndefined();
  });

  it('surfaces manual-merge even while another pipeline is running (defer is permanent, not pipeline-resolvable)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [
          makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 76 }),
          makeJob({ project: 'alpha', kind: 'release', finishedAt: null }),
        ],
        openPrNumbersByProject: { alpha: [76] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toMatchObject({ action: { prNumber: 76 } });
  });

  it('flags CI red on the default branch with a fix-ci action', () => {
    const signals = deriveInboxSignals(
      baseInput({ tasks: [makeTask({ project: 'alpha', ci: 'failure', ci_failed_url: 'https://ci/1' })] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: 'ci_red',
      severity: 'red',
      project: 'alpha',
      externalUrl: 'https://ci/1',
      action: { kind: 'fix-ci' },
    });
  });

  it('flags a review that needs a decision when no fix has chained', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'beta' })],
        jobs: [makeJob({ project: 'beta', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'NEEDS ATTENTION' })],
      }),
    );
    const s = signals.find((x) => x.type === 'review_needs_decision');
    expect(s).toBeDefined();
    expect(s).toMatchObject({ severity: 'yellow', action: { kind: 'release' } });
  });

  it('marks a DO NOT SHIP review verdict as red', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'beta' })],
        jobs: [makeJob({ project: 'beta', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'DO NOT SHIP' })],
      }),
    );
    expect(signals.find((x) => x.type === 'review_needs_decision')?.severity).toBe('red');
  });

  it('suppresses the review signal once a fix has chained after it', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'beta' })],
        jobs: [
          makeJob({ project: 'beta', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'NEEDS ATTENTION' }),
          makeJob({ project: 'beta', kind: 'fix', startedAt: 1000, finishedAt: null }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'review_needs_decision')).toBeUndefined();
  });

  it('flags an aborted release (fix loop exhausted) with an open-terminal action', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [
          makeJob({
            project: 'gamma',
            kind: 'release',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            releaseStopReason: 'review cap reached',
          }),
        ],
      }),
    );
    const s = signals.find((x) => x.type === 'fix_loop_exhausted');
    expect(s).toMatchObject({ severity: 'red', detail: 'review cap reached', action: { kind: 'open-terminal' } });
  });

  it('flags a release that stopped non-zero even with NO recorded stop reason (catch-all: never a silent stop)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: 1, releaseStopReason: null })],
      }),
    );
    const s = signals.find((x) => x.type === 'fix_loop_exhausted');
    expect(s).toMatchObject({ severity: 'red', action: { kind: 'open-terminal' } });
    expect(s?.detail).toMatch(/without shipping|needs a human/i);
  });

  it('does not double-signal a release already surfaced as a manual merge', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'pr-wait', startedAt: 800, finishedAt: 900, exitCode: 1, prWaitReason: 'conflict', prNumber: 91 }),
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 901, exitCode: 1, releaseStopReason: null }),
        ],
        openPrNumbersByProject: { gamma: [91] },
      }),
    );
    expect(signals.filter((x) => x.type === 'fix_loop_exhausted').length).toBe(0);
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeTruthy();
  });

  it('suppresses the catch-all while a newer pipeline job is re-driving the release', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: 1, releaseStopReason: null }),
          makeJob({ project: 'gamma', kind: 'fix', startedAt: 950, finishedAt: null }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeUndefined();
  });

  it('suppresses the catch-all when the release PR shipped via a merge after the release exited non-zero', () => {
    // Real case: a risky_diff defer (or a pr-wait that merged but exited non-zero
    // on a later step) is merged from the inbox after the release job already
    // exited 1. The work SHIPPED, so it must not linger as "Release stopped — no
    // merge" (the merged arm of the merge-or-HITL invariant).
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: 1, releaseStopReason: null }),
          makeJob({ project: 'gamma', kind: 'pr-wait', startedAt: 950, finishedAt: 1000, exitCode: 1, prWaitReason: 'merged', prNumber: 131 }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeUndefined();
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toBeUndefined();
  });

  it('still flags a failed release when the only merge predates it (an older merge cannot mask a newer failure)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma' })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'pr-wait', startedAt: 100, finishedAt: 200, exitCode: 0, prWaitReason: 'merged', prNumber: 10 }),
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: 1, releaseStopReason: null }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeTruthy();
  });

  it('suppresses the catch-all when a push-failure release nonetheless shipped its commits (clean tree, nothing unpushed)', () => {
    // Real case: the pre-push hook rejected during the run and the push-fix cap
    // was reached, so the release exited non-zero — but the commits still reached
    // the remote (a transient/spurious hook rejection, or a manual push). The
    // working tree is now clean with nothing unpushed, so the "push … needs
    // recovery" reason is satisfied: nothing is left to push. This is the
    // direct-push arm of the merge-or-HITL invariant (work shipped), so it must
    // not linger as a red HITL — mirrors the pr-wait `merged` suppressor.
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 0, unpushed: 0 })],
        jobs: [
          makeJob({
            project: 'gamma',
            kind: 'release',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            releaseStopReason: 'push fix cap reached for gamma (2/2) — push hook failures still need recovery',
          }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeUndefined();
  });

  it('still flags a push-failure release when commits remain unpushed (genuinely stranded)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 0, unpushed: 1 })],
        jobs: [
          makeJob({
            project: 'gamma',
            kind: 'release',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            releaseStopReason: 'push fix cap reached for gamma (2/2) — push hook failures still need recovery',
          }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeTruthy();
  });

  it('still flags a push-failure release when the working tree is dirty (unshipped work remains)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 3, unpushed: 0 })],
        jobs: [
          makeJob({
            project: 'gamma',
            kind: 'release',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            releaseStopReason: 'push fix cap reached for gamma (2/2) — push hook failures still need recovery',
          }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeTruthy();
  });

  it('does NOT suppress a non-push failure just because the tree is clean (scoped to push recovery only)', () => {
    // A review/test cap failure with a clean tree does not imply the work shipped
    // — the suppressor is scoped to push-related stop reasons so a genuinely
    // stopped release still surfaces (invariant: never a silent stop).
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 0, unpushed: 0 })],
        jobs: [
          makeJob({
            project: 'gamma',
            kind: 'release',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            releaseStopReason: 'review cap reached for gamma (3/3) — review keeps surfacing new findings, stopping',
          }),
        ],
      }),
    );
    expect(signals.find((x) => x.type === 'fix_loop_exhausted')).toBeTruthy();
  });

  it('labels a cancelled/interrupted release (exit -2, no reason) as a lower-urgency "re-run" — still surfaces, but not red', () => {
    // exit -2/-3 = cancelled (killed by a restart, probe sweep, or manual cancel).
    // The rest of the system treats these as non-failures (isCancelledExitCode);
    // the catch-all must still surface it (it didn't ship) but as an "interrupted
    // — re-run" item at yellow, NOT a red "fix loop exhausted / urgent" failure.
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 4, unpushed: 0 })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: -2, releaseStopReason: null }),
        ],
      }),
    );
    const s = signals.find((x) => x.type === 'fix_loop_exhausted');
    expect(s).toBeTruthy();
    expect(s?.severity).toBe('yellow');
    expect(s?.title).toMatch(/interrupted/i);
    expect(s?.detail).toMatch(/re-run/i);
  });

  it('keeps a genuine bare-abort failure (exit 1, no reason) red — only cancelled codes are demoted', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 4, unpushed: 0 })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: 1, releaseStopReason: null }),
        ],
      }),
    );
    const s = signals.find((x) => x.type === 'fix_loop_exhausted');
    expect(s?.severity).toBe('red');
    expect(s?.title).not.toMatch(/interrupted/i);
  });

  it('a cancelled release that DID record a real stop reason keeps that reason at red (reason is authoritative)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'gamma', changes: 4, unpushed: 0 })],
        jobs: [
          makeJob({ project: 'gamma', kind: 'release', startedAt: 500, finishedAt: 900, exitCode: -2, releaseStopReason: 'review cap reached for gamma (3/3)' }),
        ],
      }),
    );
    const s = signals.find((x) => x.type === 'fix_loop_exhausted');
    expect(s?.severity).toBe('red');
    expect(s?.detail).toBe('review cap reached for gamma (3/3)');
  });

  it('flags stale uncommitted changes with a review action', () => {
    const signals = deriveInboxSignals(
      baseInput({ tasks: [makeTask({ project: 'delta', changes: 3, reviewed: false })] }),
    );
    const s = signals.find((x) => x.type === 'stale_changes');
    expect(s).toMatchObject({ severity: 'yellow', action: { kind: 'review' } });
    expect(s?.title).toContain('3 uncommitted changes');
  });

  it('suppresses stale uncommitted changes while an agent run is in flight (it will commit + push at end of its release cycle)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'delta', changes: 2, reviewed: false })],
        jobs: [makeJob({ project: 'delta', kind: 'agent:code-crunch', finishedAt: null })],
      }),
    );
    expect(signals.find((x) => x.type === 'stale_changes')).toBeUndefined();
  });

  it('suppresses stale uncommitted changes while a terminal run is in flight', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'delta', changes: 2, reviewed: false })],
        jobs: [makeJob({ project: 'delta', kind: 'run', finishedAt: null })],
      }),
    );
    expect(signals.find((x) => x.type === 'stale_changes')).toBeUndefined();
  });

  it('still flags stale uncommitted changes once the agent run has finished', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'delta', changes: 2, reviewed: false })],
        jobs: [makeJob({ project: 'delta', kind: 'agent:code-crunch', finishedAt: 2000 })],
      }),
    );
    expect(signals.find((x) => x.type === 'stale_changes')).toBeDefined();
  });

  it('does not let another project\'s running agent suppress a stale-changes nag', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'delta', changes: 2, reviewed: false })],
        jobs: [makeJob({ project: 'other', kind: 'agent:code-crunch', finishedAt: null })],
      }),
    );
    expect(signals.find((x) => x.type === 'stale_changes')).toBeDefined();
  });

  it('surfaces an AUTO-paused project (recorded reason) as a red HITL with a Resume action', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'zeta', paused: true })],
        pausedReasonByProject: { zeta: 'Circuit breaker: 3 failed runs in 60min' },
      }),
    )
    const s = signals.find((x) => x.type === 'project_paused')
    expect(s).toMatchObject({ severity: 'red', project: 'zeta', action: { kind: 'resume', label: 'Resume' } })
    expect(s?.detail).toBe('Circuit breaker: 3 failed runs in 60min')
  })

  it('does not nag for a deliberate MANUAL pause (no recorded reason)', () => {
    const signals = deriveInboxSignals(
      baseInput({ tasks: [makeTask({ project: 'zeta', paused: true })] }),
    )
    expect(signals.find((x) => x.type === 'project_paused')).toBeUndefined()
  })

  it('suppresses the redundant project_paused when a pr_needs_manual_merge is the blocker', () => {
    // Mid-issue: the PR reached pr-wait and deferred (needs manual merge) AND the
    // project auto-paused. The manual-merge is THE blocker (and merging it resumes
    // the project), so the paused row must not also show and outrank it.
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'zeta', paused: true })],
        pausedReasonByProject: { zeta: 'Circuit breaker: 3 failed runs in 60min' },
        jobs: [makeJob({ project: 'zeta', kind: 'pr-wait', exitCode: 1, prWaitReason: 'risky_diff', prNumber: 141 })],
        openPrByProject: { zeta: { number: 141, ciGreen: true, reviewDecision: null, mergeable: 'MERGEABLE' } },
        openPrNumbersByProject: { zeta: [141] },
      }),
    )
    expect(signals.find((x) => x.type === 'project_paused')).toBeUndefined()
    const blocker = signals.find((x) => x.type === 'pr_needs_manual_merge')
    expect(blocker).toMatchObject({ severity: 'red', action: { kind: 'merge', prNumber: 141 } })
    // The manual-merge blocker is the top (red) row.
    expect(signals[0]).toBe(blocker)
  })

  it('keeps the plain project_paused row when there is no manual-merge blocker', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'zeta', paused: true })],
        pausedReasonByProject: { zeta: 'Circuit breaker' },
        openPrByProject: { zeta: { number: 9, ciGreen: false, reviewDecision: null, mergeable: 'MERGEABLE' } },
      }),
    )
    expect(signals.find((x) => x.type === 'project_paused')).toMatchObject({
      title: 'Project auto-paused — automation halted',
      action: { kind: 'resume', label: 'Resume' },
    })
  })

  it('demotes the default-branch ci_red to yellow when there is an open PR to finish', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha', ci: 'failure', ci_failed_url: 'https://ci/1' })],
        openPrByProject: { alpha: { number: 12, ciGreen: true, reviewDecision: null, mergeable: 'MERGEABLE' } },
      }),
    )
    const ci = signals.find((x) => x.type === 'ci_red')
    expect(ci).toMatchObject({ severity: 'yellow', action: { kind: 'fix-ci' } })
    expect(ci?.detail).toContain('separate from your open PR')
  })

  it('flags a mergeable PR with green CI and an LGTM verdict', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success', github: 'owner/epsilon' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: { epsilon: { number: 7, ciGreen: true, reviewDecision: null, authorTrusted: true } },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_ready_to_merge');
    expect(s).toMatchObject({ severity: 'green', action: { kind: 'merge', prNumber: 7 } });
  });

  it('does NOT flag ready-to-merge when the PR author is untrusted (e.g. dependabot / a public-repo contributor)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success', github: 'owner/epsilon' })],
        // The project has a green CI + an LGTM (from its own unrelated review),
        // but the representative open PR is from an author NOT in safe_users /
        // trusted_github_users. A one-click "ready to merge" must not appear —
        // that would nudge merging untrusted code onto the default branch.
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: {
          epsilon: { number: 30, ciGreen: true, reviewDecision: null, mergeable: 'MERGEABLE', authorLogin: 'dependabot[bot]', authorTrusted: false },
        },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_ready_to_merge')).toBeUndefined();
  });

  it('flags ready-to-merge for a MERGEABLE PR from a trusted author', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success', github: 'owner/epsilon' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: {
          epsilon: { number: 31, ciGreen: true, reviewDecision: null, mergeable: 'MERGEABLE', authorLogin: '3h4x', authorTrusted: true },
        },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_ready_to_merge')).toMatchObject({
      severity: 'green',
      action: { kind: 'merge', prNumber: 31 },
    });
  });

  it('does not flag a mergeable PR when CI is not green', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: { epsilon: { number: 7, ciGreen: false, reviewDecision: null } },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_ready_to_merge')).toBeUndefined();
  });

  it('does NOT flag a CONFLICTING PR as ready to merge even with green CI + LGTM', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success', github: 'owner/epsilon' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: { epsilon: { number: 7, ciGreen: true, reviewDecision: null, mergeable: 'CONFLICTING' } },
      }),
    );
    // The false "ready to merge / green" card must not appear...
    expect(signals.find((x) => x.type === 'pr_ready_to_merge')).toBeUndefined();
    // ...instead a conflict HITL surfaces with a resolve action (not a doomed merge).
    const conflict = signals.find((x) => x.type === 'pr_conflicts');
    expect(conflict).toMatchObject({
      severity: 'yellow',
      action: { kind: 'resolve-conflicts', prNumber: 7 },
      externalUrl: 'owner/epsilon/pull/7',
    });
    expect(conflict?.detail).toMatch(/conflicts with base/i);
    // The HITL must point at the manual path so it is not a dead-end when
    // auto-resolve is unavailable (e.g. an untrusted branch author).
    expect(conflict?.detail).toMatch(/merge it manually/i);
  });

  it('still flags a PR reported MERGEABLE as ready to merge', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: { epsilon: { number: 7, ciGreen: true, reviewDecision: null, mergeable: 'MERGEABLE', authorTrusted: true } },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_ready_to_merge')).toMatchObject({
      severity: 'green',
      action: { kind: 'merge', prNumber: 7 },
    });
    expect(signals.find((x) => x.type === 'pr_conflicts')).toBeUndefined();
  });

  it('offers resolve-conflicts (not merge) for a pr-wait conflict terminal', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', github: 'owner/epsilon' })],
        jobs: [
          makeJob({
            project: 'epsilon',
            kind: 'pr-wait',
            startedAt: 500,
            finishedAt: 900,
            exitCode: 1,
            prWaitReason: 'conflict',
            prNumber: 9,
          }),
        ],
        openPrNumbersByProject: { epsilon: [9] },
      }),
    );
    const manual = signals.find((x) => x.type === 'pr_needs_manual_merge');
    expect(manual).toMatchObject({ action: { kind: 'resolve-conflicts', prNumber: 9 } });
  });

  it('flags a stuck automation-queue entry (orphan release) once per project', () => {
    const items: AutomationQueueItem[] = [
      {
        id: 'pending_release:zeta',
        project: 'zeta',
        kind: 'pending_release',
        label: 'Queued release',
        reason: 'Release is waiting for the pipeline lock',
        code: 'pipeline_lock',
        queuedAt: 9000,
        blockingJobId: 'job-1',
        nextRetryState: 'blocked',
        retryAllowed: true,
        cancelAllowed: true,
      },
      {
        id: 'queued_agent_run:5',
        project: 'zeta',
        kind: 'queued_agent_run',
        label: 'Queued agent: x',
        reason: 'waiting',
        code: 'pipeline_lock',
        queuedAt: 9100,
        blockingJobId: 'job-1',
        nextRetryState: 'blocked',
        retryAllowed: true,
        cancelAllowed: true,
      },
    ];
    const signals = deriveInboxSignals(baseInput({ automationQueue: items }));
    const orphans = signals.filter((x) => x.type === 'orphan_release');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ severity: 'red', action: { kind: 'retry-automation' } });
  });

  it('suppresses decision signals while a pipeline is active for the project', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'eta', ci: 'failure', changes: 2, reviewed: false })],
        jobs: [makeJob({ project: 'eta', kind: 'release', startedAt: 1000, finishedAt: null })],
      }),
    );
    expect(signals.find((x) => x.type === 'ci_red')).toBeUndefined();
    expect(signals.find((x) => x.type === 'stale_changes')).toBeUndefined();
  });

  it('sorts red before yellow before green and counts by severity', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [
          makeTask({ project: 'red1', ci: 'failure' }),
          makeTask({ project: 'yellow1', changes: 1, reviewed: false }),
          makeTask({ project: 'green1', ci: 'success', github: 'o/green1' }),
        ],
        jobs: [makeJob({ project: 'green1', kind: 'review', startedAt: 1, finishedAt: 2, verdict: 'LGTM' })],
        openPrByProject: { green1: { number: 1, ciGreen: true, reviewDecision: null, authorTrusted: true } },
      }),
    );
    expect(signals.map((s) => s.severity)).toEqual(['red', 'yellow', 'green']);
    expect(countInboxSignals(signals)).toEqual({ red: 1, yellow: 1, green: 1, total: 3 });
  });
});

describe('rollupIsGreen', () => {
  const c = (conclusion: string | null) => ({ conclusion });

  it('is green when every check SUCCEEDED', () => {
    expect(rollupIsGreen([c('SUCCESS'), c('SUCCESS')], null)).toBe(true);
  });

  it('treats SKIPPED as non-blocking — SUCCESS + SKIPPED is green (a conditional job that did not run is not a failure)', () => {
    // Real case: a PR with checks [SUCCESS, SUCCESS, SUCCESS, SKIPPED, SKIPPED]
    // is mergeable on GitHub, but the old strict all-SUCCESS test suppressed its
    // pr_ready_to_merge / pr_conflicts signal.
    expect(rollupIsGreen([c('SUCCESS'), c('SKIPPED'), c('SKIPPED')], null)).toBe(true);
  });

  it('treats NEUTRAL as non-blocking (green)', () => {
    expect(rollupIsGreen([c('NEUTRAL'), c('SUCCESS')], null)).toBe(true);
  });

  it('is NOT green when any check FAILED', () => {
    expect(rollupIsGreen([c('SUCCESS'), c('FAILURE'), c('SKIPPED')], null)).toBe(false);
  });

  it('is NOT green when a check has not concluded yet (pending/empty)', () => {
    expect(rollupIsGreen([c('SUCCESS'), c(null)], null)).toBe(false);
  });

  it('handles lowercase conclusions (case-insensitive)', () => {
    expect(rollupIsGreen([{ conclusion: 'success' }, { conclusion: 'skipped' }], null)).toBe(true);
  });

  it('falls back to the project-data CI signal when the rollup is empty/absent', () => {
    expect(rollupIsGreen([], 'success')).toBe(true);
    expect(rollupIsGreen(null, 'success')).toBe(true);
    expect(rollupIsGreen(null, 'failure')).toBe(false);
    expect(rollupIsGreen(undefined, null)).toBe(false);
  });
});

describe('selectRepresentativePr', () => {
  const pr = (number: number, mergeable: string, checks: string[]) => ({
    number,
    state: 'OPEN',
    mergeable,
    statusCheckRollup: checks.map((c) => ({ conclusion: c })),
  });

  it('returns undefined for no open PRs', () => {
    expect(selectRepresentativePr([], null)).toBeUndefined();
  });

  it('does NOT let a non-green newest PR shadow an older green+conflicting one (the filmpick #112-behind-#138 bug)', () => {
    // Newest is mergeable but not green (a pending/failed check); older ones are
    // green — one conflicting (needs resolve), one mergeable. The representative
    // must be the actionable green+conflicting PR, not the newest non-green one.
    const openPrs = [
      pr(138, 'MERGEABLE', ['SUCCESS', 'FAILURE']),
      pr(112, 'CONFLICTING', ['SUCCESS', 'SUCCESS']),
      pr(110, 'MERGEABLE', ['SUCCESS', 'SUCCESS']),
    ];
    expect(selectRepresentativePr(openPrs, null)?.number).toBe(112);
  });

  it('prefers a green CONFLICTING PR over a green mergeable one (blocked outranks ready)', () => {
    const openPrs = [
      pr(50, 'MERGEABLE', ['SUCCESS']),
      pr(49, 'CONFLICTING', ['SUCCESS']),
    ];
    expect(selectRepresentativePr(openPrs, null)?.number).toBe(49);
  });

  it('picks the first green PR when none conflict (ready-to-merge candidate)', () => {
    const openPrs = [
      pr(50, 'MERGEABLE', ['FAILURE']),
      pr(49, 'MERGEABLE', ['SUCCESS', 'SKIPPED']),
    ];
    expect(selectRepresentativePr(openPrs, null)?.number).toBe(49);
  });

  it('falls back to the newest open PR when none are green (preserves prior behavior)', () => {
    const openPrs = [
      pr(50, 'MERGEABLE', ['FAILURE']),
      pr(49, 'CONFLICTING', ['FAILURE']),
    ];
    expect(selectRepresentativePr(openPrs, null)?.number).toBe(50);
  });
});
