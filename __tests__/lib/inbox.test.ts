import { describe, it, expect, vi } from 'vitest';

// deriveInboxSignals is a pure function, but the module it lives in imports
// `@/lib/db` at the top level. Stub it so importing the module never touches a
// real Postgres pool — the pure derivation never calls into it.
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }));

import {
  deriveInboxSignals,
  countInboxSignals,
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
      severity: 'yellow',
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

  it('flags a pr-wait that stopped on a merge conflict as needing manual merge (no silent stop)', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'alpha' })],
        jobs: [makeJob({ project: 'alpha', kind: 'pr-wait', exitCode: 1, prWaitReason: 'conflict', prNumber: 77 })],
        openPrNumbersByProject: { alpha: [77] },
      }),
    );
    expect(signals.find((x) => x.type === 'pr_needs_manual_merge')).toMatchObject({
      title: 'PR #77 needs manual merge',
      action: { kind: 'merge', prNumber: 77 },
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

  it('flags stale uncommitted changes with a review action', () => {
    const signals = deriveInboxSignals(
      baseInput({ tasks: [makeTask({ project: 'delta', changes: 3, reviewed: false })] }),
    );
    const s = signals.find((x) => x.type === 'stale_changes');
    expect(s).toMatchObject({ severity: 'yellow', action: { kind: 'review' } });
    expect(s?.title).toContain('3 uncommitted changes');
  });

  it('flags a mergeable PR with green CI and an LGTM verdict', () => {
    const signals = deriveInboxSignals(
      baseInput({
        tasks: [makeTask({ project: 'epsilon', ci: 'success', github: 'owner/epsilon' })],
        jobs: [makeJob({ project: 'epsilon', kind: 'review', startedAt: 500, finishedAt: 900, verdict: 'LGTM' })],
        openPrByProject: { epsilon: { number: 7, ciGreen: true, reviewDecision: null } },
      }),
    );
    const s = signals.find((x) => x.type === 'pr_ready_to_merge');
    expect(s).toMatchObject({ severity: 'green', action: { kind: 'merge', prNumber: 7 } });
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
        openPrByProject: { green1: { number: 1, ciGreen: true, reviewDecision: null } },
      }),
    );
    expect(signals.map((s) => s.severity)).toEqual(['red', 'yellow', 'green']);
    expect(countInboxSignals(signals)).toEqual({ red: 1, yellow: 1, green: 1, total: 3 });
  });
});
