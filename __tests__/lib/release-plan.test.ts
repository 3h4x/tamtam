import { beforeEach, describe, expect, it, vi } from 'vitest';

// The planner reuses the REAL decideNextPhase + review-scope (pure logic) and
// mocks only the IO-bound helpers, so these tests verify the plan stays in
// lock-step with the actual transition matcher.
describe('computeReleasePlan', () => {
  let computeReleasePlan: typeof import('@/lib/pipeline/release-plan').computeReleasePlan;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let isArchivedMock: ReturnType<typeof vi.fn>;
  let isPausedMock: ReturnType<typeof vi.fn>;
  let detectTestCommandMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let hasFreshLgtmMock: ReturnType<typeof vi.fn>;
  let hasLocalCommitsAheadMock: ReturnType<typeof vi.fn>;
  let decidePrContextMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let findActivePrWaitMock: ReturnType<typeof vi.fn>;

  const config = (over: Record<string, unknown> = {}) => ({
    testCommand: 'pnpm test',
    quarantinedTests: [],
    testCronEnabled: false,
    testCronSchedule: null,
    autoCommitEnabled: false,
    autoPushEnabled: true,
    autoPrMergeEnabled: false,
    releaseAfterRun: false,
    issueAutoBranch: true,
    testsDisabled: false,
    reviewDisabled: false,
    postMergeWatchMinutes: 0,
    autoRevertEnabled: false,
    ...over,
  });

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('rev-parse')) return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    resolveProjectPathMock = vi.fn().mockReturnValue('/repo/proj');
    isArchivedMock = vi.fn().mockReturnValue(false);
    isPausedMock = vi.fn().mockReturnValue(false);
    detectTestCommandMock = vi.fn().mockResolvedValue('pnpm test');
    getProjectTestConfigMock = vi.fn().mockResolvedValue(config());
    hasFreshLgtmMock = vi.fn().mockResolvedValue(false);
    hasLocalCommitsAheadMock = vi.fn().mockResolvedValue(false);
    decidePrContextMock = vi.fn().mockResolvedValue({
      shouldOpenPr: false,
      reason: 'matches default',
      currentBranch: 'main',
      defaultBranch: 'main',
    });
    listJobsMock = vi.fn().mockReturnValue([]);
    findActivePrWaitMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      isProjectArchived: isArchivedMock,
      isProjectPaused: isPausedMock,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ detectTestCommand: detectTestCommandMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getProjectTestConfig: getProjectTestConfigMock }));
    vi.doMock('@/lib/pipeline/release-state', () => ({
      hasFreshLgtm: hasFreshLgtmMock,
      hasLocalCommitsAhead: hasLocalCommitsAheadMock,
    }));
    vi.doMock('@/lib/pipeline/pr-context', () => ({ decidePrContext: decidePrContextMock }));
    vi.doMock('@/lib/jobs/job-storage', () => ({ listJobs: listJobsMock }));
    vi.doMock('@/lib/pipeline/start-release', () => ({
      findActivePrWait: findActivePrWaitMock,
      RELEASE_PIPELINE_KINDS: new Set(['test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'release']),
    }));
    vi.doMock('@/lib/git/git-branch', () => ({ getDefaultBranchSync: vi.fn().mockReturnValue('main') }));

    ({ computeReleasePlan } = await import('@/lib/pipeline/release-plan'));
  });

  const runs = (plan: Awaited<ReturnType<typeof computeReleasePlan>>) =>
    plan.steps.filter((s) => s.willRun).map((s) => s.kind);

  it('dirty tree on a feature branch: test→review→commit→push→mark-dod→pr-wait when auto-merge on', async () => {
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/feature\n', stderr: '' };
    });
    getProjectTestConfigMock.mockResolvedValue(config({ autoPrMergeEnabled: true }));
    decidePrContextMock.mockResolvedValue({
      shouldOpenPr: true, reason: 'differs', currentBranch: 'feature', defaultBranch: 'main',
    });

    const plan = await computeReleasePlan('proj');

    expect(plan.canRelease).toBe(true);
    expect(plan.mode).toBe('pr');
    expect(plan.entryStep).toBe('test');
    expect(runs(plan)).toEqual(['test', 'review', 'commit', 'push', 'mark-dod', 'pr-wait']);
    const push = plan.steps.find((s) => s.kind === 'push')!;
    expect(push.comparisonRange).toBe('origin/feature..HEAD');
    expect(push.sideEffects).toContain('Opens or reuses a GitHub PR');
  });

  it('clean tree with local commits ahead, direct branch: review→commit→push→mark-dod, no pr-wait', async () => {
    hasLocalCommitsAheadMock.mockResolvedValue(true); // unpushed, no working-tree changes
    const plan = await computeReleasePlan('proj');

    expect(plan.mode).toBe('direct');
    // No uncommitted changes + tests configured → test runs first.
    expect(plan.entryStep).toBe('test');
    expect(runs(plan)).toEqual(['test', 'review', 'commit', 'push', 'mark-dod']);
    const prWait = plan.steps.find((s) => s.kind === 'pr-wait')!;
    expect(prWait.willRun).toBe(false);
    expect(prWait.reason).toMatch(/Direct push/);
  });

  it('no test command configured skips the test step', async () => {
    detectTestCommandMock.mockResolvedValue(null);
    getProjectTestConfigMock.mockResolvedValue(config({ testCommand: null }));
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
    });

    const plan = await computeReleasePlan('proj');

    expect(plan.entryStep).toBe('review');
    const test = plan.steps.find((s) => s.kind === 'test')!;
    expect(test.willRun).toBe(false);
    expect(test.reason).toMatch(/No test command/);
    expect(runs(plan)).toEqual(['review', 'commit', 'push', 'mark-dod']);
  });

  it('fresh LGTM with dirty tree skips test+review, commits then pushes', async () => {
    hasFreshLgtmMock.mockResolvedValue(true);
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
    });

    const plan = await computeReleasePlan('proj');

    expect(plan.entryStep).toBe('commit');
    expect(runs(plan)).toEqual(['commit', 'push', 'mark-dod']);
    const review = plan.steps.find((s) => s.kind === 'review')!;
    expect(review.willRun).toBe(false);
    expect(review.reason).toMatch(/Fresh LGTM/);
  });

  it('nothing to release produces a blocker and an empty step list', async () => {
    // clean tree, no unpushed commits (defaults)
    const plan = await computeReleasePlan('proj');

    expect(plan.canRelease).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toContain('nothing_to_release');
    expect(plan.entryStep).toBeNull();
    expect(runs(plan)).toEqual([]);
  });

  it('a running non-pipeline job blocks the release but still shows the plan', async () => {
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
    });
    // Non-finished, non-pipeline job for this project → job_running blocker,
    // read directly from listJobs without probing (no markDone side effect).
    listJobsMock.mockReturnValue([
      { id: 'job-9', project: 'proj', kind: 'run', finishedAt: null },
    ]);

    const plan = await computeReleasePlan('proj');

    expect(plan.canRelease).toBe(false);
    expect(plan.blockers[0]).toMatchObject({ code: 'job_running', blockingJobId: 'job-9' });
    expect(plan.entryStep).toBe('test'); // plan still computed
  });

  it('an unfinished pipeline job surfaces pipeline_running without probing', async () => {
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
    });
    listJobsMock.mockReturnValue([
      { id: 'rel-1', project: 'proj', kind: 'release', finishedAt: null },
    ]);

    const plan = await computeReleasePlan('proj');

    expect(plan.canRelease).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toContain('pipeline_running');
  });

  it('performs no git writes — only read-only git commands are issued', async () => {
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('status')) return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
    });

    await computeReleasePlan('proj');

    const writeVerbs = ['commit', 'push', 'add', 'checkout', 'merge', 'reset', 'tag', 'branch'];
    for (const call of execMock.mock.calls) {
      const args: string[] = call[1];
      for (const verb of writeVerbs) {
        expect(args).not.toContain(verb);
      }
    }
  });

  it('returns not_found for an unknown project', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const plan = await computeReleasePlan('ghost');
    expect(plan.blockers).toEqual([{ code: 'not_found', detail: 'project not found' }]);
    expect(plan.steps).toEqual([]);
  });
});
