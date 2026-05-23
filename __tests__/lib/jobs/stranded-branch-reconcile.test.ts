import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

// `findStrandedBranches` is pure-ish: it reads project list, project path,
// pipeline lock state, running jobs, and shells out to git. We stub all of
// those so the test is hermetic.

interface GitResp { exitCode: number; stdout: string; stderr?: string }

function makeJob(overrides: Partial<JobData> & Pick<JobData, 'id' | 'kind'>): JobData {
  return {
    id: overrides.id,
    project: overrides.project ?? 'proj',
    kind: overrides.kind,
    prompt: null,
    pid: 99999,
    logPath: null,
    startedAt: overrides.startedAt ?? 100,
    finishedAt: overrides.finishedAt ?? null,
    exitCode: overrides.exitCode ?? null,
    seen: false,
    releaseId: overrides.releaseId ?? null,
  };
}

function gitStub(map: Record<string, GitResp>) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    // `gitOutput` calls `exec('git', ['-C', path, ...args])`, so strip the
    // `-C /tmp/proj` prefix when matching keys.
    const trimmed = args[0] === '-C' ? args.slice(2) : args;
    const key = trimmed.join(' ');
    if (map[key]) return map[key];
    // Default: success with empty stdout. Mimics e.g. `git status --porcelain`
    // returning nothing for a clean tree.
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

function withCommonStubs(
  gitResponses: Record<string, GitResp>,
  options: { jobs?: JobData[]; pendingRelease?: boolean; commitRecoveryMarker?: boolean } = {},
) {
  const exec = gitStub(gitResponses);
  vi.doMock('@/lib/shared/enabled-projects', () => ({
    listEnabledProjects: () => [{ name: 'proj' }],
    isProjectArchived: () => false,
    isProjectPaused: () => false,
  }));
  vi.doMock('@/lib/shared/project-data', () => ({
    resolveProjectPath: () => '/tmp/proj',
  }));
  vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
    getLock: async () => null,
    isLockOwnedByActiveRelease: async () => false,
  }));
  vi.doMock('@/lib/jobs/job-storage', () => ({
    listJobs: () => options.jobs ?? [],
  }));
  vi.doMock('@/lib/jobs/kinds', () => ({
    isAgentJobKind: () => false,
  }));
  vi.doMock('@/lib/pipeline/pending-release', () => ({
    getPendingRelease: vi.fn().mockResolvedValue(!!options.pendingRelease),
  }));
  vi.doMock('@/lib/pipeline/commit-recovery-marker', () => ({
    hasDefaultDirtyCommitRecoveryMarker: vi.fn().mockResolvedValue(!!options.commitRecoveryMarker),
  }));
  vi.doMock('@/lib/shared/shell', () => ({ exec }));
  return { exec };
}

describe('findStrandedBranches', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('classifies as fix-branch when only `.tamtam/` paths are dirty and all commits are pushed', async () => {
    // `startRelease` now commits `.tamtam/`-only work directly because review
    // intentionally excludes those paths. The reconciler should therefore
    // treat `.tamtam/` dirt as recoverable work instead of mistaking this for
    // a clean PR-wait branch.
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-27-add-smoke-tests' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '15' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '15' },
      'status --porcelain': {
        exitCode: 0,
        stdout: ' D .tamtam/agents/improve.md\n?? .tamtam/agents/improve-app.md',
      },
      // upstreamAhead === 0 confirms all commits pushed
      'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '0' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('fix-branch');
    expect(candidates[0].ahead).toBe(15);
  });

  it('classifies as fix-branch when working tree has non-`.tamtam/` dirt', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-99-some-fix' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '0' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '0' },
      'status --porcelain': {
        exitCode: 0,
        stdout: ' M src/index.ts\n?? .tamtam/agents/improve.md',
      },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('fix-branch');
  });

  it('classifies as fix-branch when only `.tamtam/` paths are dirty and branch has no commits ahead', async () => {
    // `.tamtam/`-only config drift is shippable by the release router now.
    // Do not classify it as empty or skip it; startRelease can commit it.
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-5-old-branch' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '0' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '0' },
      'status --porcelain': {
        exitCode: 0,
        stdout: ' M .tamtam/agents/improve.md',
      },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('fix-branch');
    expect(candidates[0].ahead).toBe(0);
  });

  it('still classifies fully clean stranded branch with no commits as empty-fix-branch', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-7-no-work' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '0' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '0' },
      'status --porcelain': { exitCode: 0, stdout: '' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('empty-fix-branch');
  });

  it('classifies fully-clean stranded branch with commits not yet pushed as fix-branch', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-11-unpushed' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '3' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '3' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      // upstreamAhead > 0: commits exist locally but haven't been pushed.
      'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '3' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('fix-branch');
    expect(candidates[0].ahead).toBe(3);
  });

  it('skips fully pushed clean fix branches that are already waiting on PR merge', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'fix/issue-42-awaiting-merge' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'rev-list --count main..HEAD': { exitCode: 0, stdout: '2' },
      'rev-list --count origin/main..HEAD': { exitCode: 0, stdout: '2' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '0' },
    });

    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());

    expect(candidates).toEqual([]);
  });

  it('emits no candidate for a dirty default branch without release evidence', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: ' M app/components/indexnow-button.tsx' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toEqual([]);
  });

  it('classifies a dirty default branch with a pending release as default-dirty → release', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: ' M app/components/indexnow-button.tsx' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    }, { pendingRelease: true });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('default-dirty');
    expect(candidates[0].branch).toBe('main');
  });

  it('does not classify a dirty default branch solely from stale failed commit release history', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: ' M app/components/indexnow-button.tsx' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    }, {
      jobs: [
        makeJob({ id: 'release-1', kind: 'release', startedAt: 100, finishedAt: 200, exitCode: 1 }),
        makeJob({ id: 'commit-1', kind: 'commit', startedAt: 150, finishedAt: 190, exitCode: 1, releaseId: 'release-1' }),
      ],
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toEqual([]);
  });

  it('classifies a dirty default branch with a matching failed-commit recovery marker', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: ' M app/components/indexnow-button.tsx' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    }, { commitRecoveryMarker: true });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('default-dirty');
  });

  it('dispatches a release for a dirty default branch with release evidence', async () => {
    const releaseWorkflow = {};
    const start = vi.fn().mockResolvedValue({
      returnValue: Promise.resolve({ ok: true, step: 'review' }),
    });
    vi.doMock('workflow/api', () => ({ start }));
    vi.doMock('@/lib/workflows/release', () => ({ releaseWorkflow }));
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: ' M app/components/indexnow-button.tsx' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    }, { pendingRelease: true });

    const { reconcileStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const summary = await reconcileStrandedBranches(Date.now());

    expect(start).toHaveBeenCalledWith(releaseWorkflow, ['proj', { queueIfBlocked: true }]);
    expect(summary.triggered).toEqual([
      expect.objectContaining({ project: 'proj', kind: 'default-dirty', outcome: 'started' }),
    ]);
  });

  it('still classifies a clean default branch that is ahead/behind as default-out-of-sync → push', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +2 -1' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('default-out-of-sync');
    expect(candidates[0].ahead).toBe(2);
    expect(candidates[0].behind).toBe(1);
  });

  it('emits no candidate for a clean, in-sync default branch', async () => {
    withCommonStubs({
      'branch --show-current': { exitCode: 0, stdout: 'main' },
      'symbolic-ref refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      'status --porcelain=v2 --branch': { exitCode: 0, stdout: '# branch.ab +0 -0' },
    });
    const { findStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    const candidates = await findStrandedBranches(Date.now());
    expect(candidates).toEqual([]);
  });
});
