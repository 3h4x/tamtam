import { describe, it, expect, vi } from 'vitest';
import {
  decideSweepAction,
  runSweep,
  summarizeDefaultBranchCi,
  type ProjectSweepView,
} from '@/lib/jobs/project-sweep';
import { decideAutoFixCi, type AutoFixCiEntry } from '@/lib/jobs/auto-fix-ci-state';

function view(overrides: Partial<ProjectSweepView> = {}): ProjectSweepView {
  return {
    name: 'p',
    path: '/repo/p',
    currentBranch: 'main',
    defaultBranch: 'main',
    uncommittedCount: 0,
    hasUnpushedCommits: false,
    hasActiveJob: false,
    defaultBranchCi: 'success',
    defaultBranchCiFailedUrl: null,
    prOnBranch: null,
    paused: false,
    autoPushEnabled: false,
    autoFixCiEnabled: false,
    ...overrides,
  };
}

describe('decideSweepAction', () => {
  it('skips paused projects', () => {
    expect(decideSweepAction(view({ paused: true })).kind).toBe('skip');
  });
  it('skips projects with an active job', () => {
    expect(decideSweepAction(view({ hasActiveJob: true, uncommittedCount: 3 })).kind).toBe('skip');
  });
  it('skips changes on default branch (auto-release disabled there)', () => {
    const a = decideSweepAction(view({ uncommittedCount: 5 }));
    expect(a.kind).toBe('skip');
    expect(a.reason).toMatch(/default branch/);
  });
  it('skips unpushed commits on default branch (auto-release disabled there)', () => {
    const a = decideSweepAction(view({ hasUnpushedCommits: true }));
    expect(a.kind).toBe('skip');
  });
  it('triggers release on default branch with work when auto-push is enabled', () => {
    const a = decideSweepAction(view({ autoPushEnabled: true, uncommittedCount: 2 }));
    expect(a.kind).toBe('release');
    expect(a.reason).toMatch(/auto_push/);
  });
  it('triggers release on non-default branch with changes (regardless of CI)', () => {
    const a = decideSweepAction(view({ currentBranch: 'fix/issue-1', uncommittedCount: 4, defaultBranchCi: 'failure' }));
    expect(a.kind).toBe('release');
  });
  it('dispatches pr-wait on non-default + clean + mergeable PR + green CI', () => {
    const a = decideSweepAction(view({
      currentBranch: 'fix/issue-1',
      prOnBranch: { number: 42, repo: 'owner/repo', url: 'https://gh/pr/42', mergeable: 'MERGEABLE', ciConclusion: 'success' },
    }));
    expect(a.kind).toBe('pr-wait');
    if (a.kind === 'pr-wait') {
      expect(a.prNumber).toBe(42);
      expect(a.prUrl).toBe('https://gh/pr/42');
    }
  });
  it('skips pr-wait when PR has conflicts', () => {
    const a = decideSweepAction(view({
      currentBranch: 'fix/issue-1',
      prOnBranch: { number: 42, repo: 'o/r', url: 'u', mergeable: 'CONFLICTING', ciConclusion: 'success' },
    }));
    expect(a.kind).toBe('skip');
    expect(a.reason).toMatch(/conflicts/);
  });
  it('skips pr-wait when CI failed', () => {
    const a = decideSweepAction(view({
      currentBranch: 'fix/issue-1',
      prOnBranch: { number: 42, repo: 'o/r', url: 'u', mergeable: 'MERGEABLE', ciConclusion: 'failure' },
    }));
    expect(a.kind).toBe('skip');
  });
  it('skips pr-wait when CI pending', () => {
    const a = decideSweepAction(view({
      currentBranch: 'fix/issue-1',
      prOnBranch: { number: 42, repo: 'o/r', url: 'u', mergeable: 'MERGEABLE', ciConclusion: 'pending' },
    }));
    expect(a.kind).toBe('skip');
  });
  it('skips when non-default branch has no work and no PR', () => {
    const a = decideSweepAction(view({ currentBranch: 'fix/orphan' }));
    expect(a.kind).toBe('skip');
    expect(a.reason).toMatch(/no open PR/);
  });
  it('skips when already clean on default', () => {
    expect(decideSweepAction(view()).reason).toBe('already clean on default');
  });

  it('auto-dispatches fix-ci on clean default branch with red CI when both flags are on', () => {
    const a = decideSweepAction(view({
      defaultBranchCi: 'failure',
      defaultBranchCiFailedUrl: 'https://gh/runs/9',
      autoFixCiEnabled: true,
      autoPushEnabled: true,
    }));
    expect(a.kind).toBe('fix-ci');
    if (a.kind === 'fix-ci') expect(a.failedUrl).toBe('https://gh/runs/9');
  });

  it('does NOT auto-dispatch fix-ci when the global setting is off', () => {
    const a = decideSweepAction(view({ defaultBranchCi: 'failure', autoFixCiEnabled: false, autoPushEnabled: true }));
    expect(a.kind).toBe('skip');
  });

  it('does NOT auto-dispatch fix-ci without the per-project auto_push authorization', () => {
    const a = decideSweepAction(view({ defaultBranchCi: 'failure', autoFixCiEnabled: true, autoPushEnabled: false }));
    expect(a.kind).toBe('skip');
  });

  it('does NOT auto-dispatch fix-ci while there is pending work (release handles that)', () => {
    const a = decideSweepAction(view({
      defaultBranchCi: 'failure',
      autoFixCiEnabled: true,
      autoPushEnabled: true,
      uncommittedCount: 2,
    }));
    expect(a.kind).toBe('release');
  });

  it('does NOT auto-dispatch fix-ci from a feature branch (fix would land on the wrong branch)', () => {
    const a = decideSweepAction(view({
      currentBranch: 'fix/x',
      defaultBranchCi: 'failure',
      autoFixCiEnabled: true,
      autoPushEnabled: true,
    }));
    // Feature branch + no work + no PR → needs human, never fix-ci.
    expect(a.kind).toBe('skip');
  });
});

describe('runSweep', () => {
  it('walks all projects and aggregates by action', async () => {
    const views: Record<string, ProjectSweepView> = {
      a: view({ name: 'a', currentBranch: 'fix/x', uncommittedCount: 3 }),
      b: view({ name: 'b', currentBranch: 'fix/x', prOnBranch: { number: 1, repo: 'o/r', url: 'u', mergeable: 'MERGEABLE', ciConclusion: 'success' } }),
      c: view({ name: 'c' }), // clean
    };
    const triggerRelease = vi.fn().mockResolvedValue({ ok: true, detail: 'started' });
    const triggerPrWait = vi.fn().mockResolvedValue({ ok: true, detail: 'pr-wait-1' });
    const triggerFixCi = vi.fn().mockResolvedValue({ ok: true, detail: 'fix-ci' });
    const report = await runSweep({
      listProjects: async () => ['a', 'b', 'c'],
      resolveView: async (n) => views[n] ?? null,
      triggerRelease,
      triggerPrWait,
      triggerFixCi,
    });
    expect(report.total).toBe(3);
    expect(report.byAction).toEqual({ release: 1, 'pr-wait': 1, 'fix-ci': 0, skip: 1 });
    expect(triggerRelease).toHaveBeenCalledWith('a', expect.any(String));
    expect(triggerPrWait).toHaveBeenCalledWith('b', 1, 'o/r', 'u', expect.any(String));
  });
  it('dispatches fix-ci via runSweep for a red clean default branch', async () => {
    const triggerFixCi = vi.fn().mockResolvedValue({ ok: true, detail: 'fix-ci' });
    const report = await runSweep({
      listProjects: async () => ['a'],
      resolveView: async () => view({
        name: 'a',
        defaultBranchCi: 'failure',
        defaultBranchCiFailedUrl: 'https://gh/runs/1',
        autoFixCiEnabled: true,
        autoPushEnabled: true,
      }),
      triggerRelease: vi.fn(),
      triggerPrWait: vi.fn(),
      triggerFixCi,
    });
    expect(report.byAction['fix-ci']).toBe(1);
    expect(triggerFixCi).toHaveBeenCalledWith('a', expect.any(String), 'https://gh/runs/1');
  });
  it('skips a project whose resolveView throws', async () => {
    const report = await runSweep({
      listProjects: async () => ['a'],
      resolveView: async () => { throw new Error('git timeout'); },
      triggerRelease: vi.fn(),
      triggerPrWait: vi.fn(),
      triggerFixCi: vi.fn(),
    });
    expect(report.results[0].action).toBe('skip');
    expect(report.results[0].reason).toMatch(/view error/);
  });
});

describe('summarizeDefaultBranchCi', () => {
  it('returns null for no runs', () => {
    expect(summarizeDefaultBranchCi([])).toEqual({ ci: null, failedUrl: null });
  });
  it('marks failure and captures the failing URL even when a newer different workflow is green', () => {
    // gh lists newest-first; a red Deploy must not be masked by a green Release.
    const r = summarizeDefaultBranchCi([
      { workflowName: 'Release', status: 'completed', conclusion: 'success', url: 'u-rel' },
      { workflowName: 'Deploy', status: 'completed', conclusion: 'failure', url: 'u-dep' },
    ]);
    expect(r).toEqual({ ci: 'failure', failedUrl: 'u-dep' });
  });
  it('keeps only the latest run per workflow (fresh success supersedes older failure)', () => {
    const r = summarizeDefaultBranchCi([
      { workflowName: 'Deploy', status: 'completed', conclusion: 'success', url: 'new' },
      { workflowName: 'Deploy', status: 'completed', conclusion: 'failure', url: 'old' },
    ]);
    expect(r.ci).toBe('success');
  });
  it('reports pending when a workflow is still running and none failed', () => {
    const r = summarizeDefaultBranchCi([
      { workflowName: 'Deploy', status: 'in_progress', conclusion: null, url: 'u' },
      { workflowName: 'Release', status: 'completed', conclusion: 'success', url: 'u2' },
    ]);
    expect(r.ci).toBe('pending');
  });
  it('ignores dependabot/label noise workflows', () => {
    const r = summarizeDefaultBranchCi([
      { workflowName: 'Dependabot Updates', status: 'completed', conclusion: 'failure', url: 'dep' },
      { workflowName: 'Deploy', status: 'completed', conclusion: 'success', url: 'ok' },
    ]);
    expect(r.ci).toBe('success');
  });
});

describe('decideAutoFixCi', () => {
  const CAP = 3;
  it('refuses without a failing-run key', () => {
    expect(decideAutoFixCi(undefined, null, CAP).dispatch).toBe(false);
    expect(decideAutoFixCi(undefined, '', CAP).dispatch).toBe(false);
  });
  it('dispatches the first time and returns the next entry', () => {
    const d = decideAutoFixCi(undefined, 'https://gh/runs/1', CAP);
    expect(d.dispatch).toBe(true);
    expect(d.next).toEqual<AutoFixCiEntry>({ lastFailureKey: 'https://gh/runs/1', attempts: 1 });
  });
  it('does NOT re-dispatch the same failing run', () => {
    const entry: AutoFixCiEntry = { lastFailureKey: 'https://gh/runs/1', attempts: 1 };
    expect(decideAutoFixCi(entry, 'https://gh/runs/1', CAP).dispatch).toBe(false);
  });
  it('dispatches for a new failing run until the cap, then stops', () => {
    const atCap: AutoFixCiEntry = { lastFailureKey: 'https://gh/runs/old', attempts: CAP };
    expect(decideAutoFixCi(atCap, 'https://gh/runs/new', CAP).dispatch).toBe(false);
    const belowCap: AutoFixCiEntry = { lastFailureKey: 'https://gh/runs/old', attempts: CAP - 1 };
    const d = decideAutoFixCi(belowCap, 'https://gh/runs/new', CAP);
    expect(d.dispatch).toBe(true);
    expect(d.next?.attempts).toBe(CAP);
  });
});
