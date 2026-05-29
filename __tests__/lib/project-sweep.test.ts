import { describe, it, expect, vi } from 'vitest';
import { decideSweepAction, runSweep, type ProjectSweepView } from '@/lib/jobs/project-sweep';

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
    prOnBranch: null,
    paused: false,
    autoPushEnabled: false,
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
    const report = await runSweep({
      listProjects: async () => ['a', 'b', 'c'],
      resolveView: async (n) => views[n] ?? null,
      triggerRelease,
      triggerPrWait,
    });
    expect(report.total).toBe(3);
    expect(report.byAction).toEqual({ release: 1, 'pr-wait': 1, skip: 1 });
    expect(triggerRelease).toHaveBeenCalledWith('a', expect.any(String));
    expect(triggerPrWait).toHaveBeenCalledWith('b', 1, 'o/r', 'u', expect.any(String));
  });
  it('skips a project whose resolveView throws', async () => {
    const report = await runSweep({
      listProjects: async () => ['a'],
      resolveView: async () => { throw new Error('git timeout'); },
      triggerRelease: vi.fn(),
      triggerPrWait: vi.fn(),
    });
    expect(report.results[0].action).toBe('skip');
    expect(report.results[0].reason).toMatch(/view error/);
  });
});
