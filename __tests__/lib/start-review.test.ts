import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  startJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  listJobs: vi.fn(),
  readLog: vi.fn(),
  readParsedLog: vi.fn(),
  probeJobStatus: vi.fn(),
  getLock: vi.fn(),
  acquireLock: vi.fn(),
  isLockOwnedByActiveRelease: vi.fn(),
  checkCliStartGate: vi.fn(),
  findReleaseScopedIssueContext: vi.fn(),
  loadFileConfig: vi.fn(),
  resolveProjectPath: vi.fn(),
  getProjectTestConfig: vi.fn(),
  getProjectPipelinePrompts: vi.fn(),
  getProjectQaTarget: vi.fn(),
  getSettings: vi.fn(),
  checkPrBranchExecutionGate: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  resolveAutoAttachedDocs: vi.fn(),
  formatAutoAttachedDocsBlock: vi.fn(),
  codeReviewerSkillPath: '/nonexistent/code-reviewer.md',
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: (...args: unknown[]) => mocks.exec(...args),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...args: unknown[]) => mocks.resolveProjectPath(...args),
}));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
  getProjectTestConfig: (...args: unknown[]) => mocks.getProjectTestConfig(...args),
  getProjectPipelinePrompts: (...args: unknown[]) => mocks.getProjectPipelinePrompts(...args),
  getProjectQaTarget: (...args: unknown[]) => mocks.getProjectQaTarget(...args),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...args: unknown[]) => mocks.createJob(...args),
  updateJob: (...args: unknown[]) => mocks.updateJob(...args),
  listJobs: (...args: unknown[]) => mocks.listJobs(...args),
  readLog: (...args: unknown[]) => mocks.readLog(...args),
  readParsedLog: (...args: unknown[]) => mocks.readParsedLog(...args),
  probeJobStatus: (...args: unknown[]) => mocks.probeJobStatus(...args),
}));


vi.mock('@/lib/jobs/spawn-claude-detached', () => ({
  startJobInProcess: (...args: unknown[]) => mocks.startJob(...args),
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: (...args: unknown[]) => mocks.getSettings(...args),
  withBasePrompt: (s: string) => s,
  getPermissionModeFlag: () => '--dangerously-skip-permissions',
  getPipelineModel: () => 'sonnet',
}));

vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: (...args: unknown[]) => mocks.getLock(...args),
  acquireLock: (...args: unknown[]) => mocks.acquireLock(...args),
  isLockOwnedByActiveRelease: (...args: unknown[]) => mocks.isLockOwnedByActiveRelease(...args),
}));

vi.mock('@/lib/skills/skills', () => ({
  get CODE_REVIEWER_SKILL() {
    return mocks.codeReviewerSkillPath;
  },
}));

vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: (...args: unknown[]) => mocks.checkCliStartGate(...args),
}));

vi.mock('@/lib/pipeline/release-context', () => ({
  findReleaseScopedIssueContext: (...args: unknown[]) => mocks.findReleaseScopedIssueContext(...args),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mocks.existsSync(...args),
  lstatSync: (...args: unknown[]) => mocks.lstatSync(...args),
  readFileSync: (...args: unknown[]) => mocks.readFileSync(...args),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: (...args: unknown[]) => mocks.loadFileConfig(...args),
}));

vi.mock('@/lib/skills/auto-attach-docs', () => ({
  resolveAutoAttachedDocs: (...args: unknown[]) => mocks.resolveAutoAttachedDocs(...args),
  formatAutoAttachedDocsBlock: (...args: unknown[]) => mocks.formatAutoAttachedDocsBlock(...args),
}));

vi.mock('@/lib/security/pr-branch-execution', () => ({
  checkPrBranchExecutionGate: (...args: unknown[]) => mocks.checkPrBranchExecutionGate(...args),
}));

import { startProjectReview } from '@/lib/pipeline/start-review';

function resp(exitCode: number, stdout = '', stderr = '') {
  return Promise.resolve({ exitCode, stdout, stderr });
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-job-1',
    project: 'proj',
    kind: 'review',
    pid: 0,
    logPath: null,
    prompt: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.exec.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.findReleaseScopedIssueContext.mockReset().mockReturnValue(null);
  mocks.startJob.mockReset().mockResolvedValue(9999);
  mocks.updateJob.mockReset();
  mocks.listJobs.mockReset().mockReturnValue([]);
  mocks.readLog.mockReset().mockReturnValue('');
  mocks.readParsedLog.mockReset().mockReturnValue('');
  mocks.probeJobStatus.mockReset().mockResolvedValue('done');
  mocks.getLock.mockReset().mockReturnValue(null);
  mocks.acquireLock.mockReset().mockResolvedValue({ acquired: true });
  mocks.isLockOwnedByActiveRelease.mockReset().mockReturnValue(false);
  mocks.checkCliStartGate.mockReset().mockResolvedValue({ ok: true, provider: 'claude' });
  mocks.loadFileConfig.mockReset().mockReturnValue(null);
  mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
  mocks.getProjectTestConfig.mockReset().mockReturnValue({});
  mocks.getProjectPipelinePrompts.mockReset().mockResolvedValue({
    reviewPromptAddendum: null,
    reviewPrerequisiteCommand: null,
    fixPromptAddendum: null,
  });
  mocks.getProjectQaTarget.mockReset().mockResolvedValue(null);
  mocks.getSettings.mockReset().mockReturnValue({
    review_verdict_rules: 'Use LGTM / NEEDS ATTENTION / DO NOT SHIP.',
  });
  mocks.checkPrBranchExecutionGate.mockReset().mockReturnValue({ ok: true, reason: 'default_branch' });
  mocks.existsSync.mockReset().mockReturnValue(false);
  mocks.lstatSync.mockReset();
  mocks.readFileSync.mockReset();
  mocks.resolveAutoAttachedDocs.mockReset().mockReturnValue([]);
  mocks.formatAutoAttachedDocsBlock.mockReset().mockReturnValue(null);
  mocks.codeReviewerSkillPath = '/nonexistent/code-reviewer.md';

  mocks.createJob.mockReset().mockImplementation((project: string, kind: string) => ({
    id: `${project}-${kind}-id`,
    project,
    kind,
    pid: 0,
    logPath: '',
    prompt: null,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    seen: false,
  }));
});

describe('startProjectReview', () => {
  it('returns 400 when review_disabled is set for the project', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ reviewDisabled: true });

    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('disabled');
    }
  });

  it('returns 404 when project path cannot be resolved', async () => {
    mocks.resolveProjectPath.mockReturnValue(null);

    const r = await startProjectReview('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 429 when every enabled provider is over budget', async () => {
    mocks.checkCliStartGate.mockResolvedValue({
      ok: false,
      status: 429,
      detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
    });
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('passes through a preferred provider override when supplied', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ' M file.ts\n'));

    await startProjectReview('proj', { preferredProvider: 'codex' });

    expect(mocks.checkCliStartGate).toHaveBeenCalledWith('start a review', {
      parentJobId: null,
      preferred: 'codex',
      requestedModel: 'normal',
    });
  });

  it('returns 409 when pipeline lock is held by another job', async () => {
    mocks.getLock.mockReturnValue({ lockedByJobId: 'other-job' });
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.blockingJobId).toBe('other-job');
    }
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('bypasses lock check when under an active release', async () => {
    mocks.getLock.mockReturnValue({ lockedByJobId: 'release-job' });
    mocks.isLockOwnedByActiveRelease.mockReturnValue(true);
    mocks.exec.mockResolvedValueOnce(resp(0, ''));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 409 when a review is already running for the project', async () => {
    mocks.listJobs.mockReturnValue([makeJob({ kind: 'review', finishedAt: null })]);
    mocks.probeJobStatus.mockResolvedValue('running');
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already in progress');
    }
  });

  it('returns 409 when any active review probe reports running even if another probe fails', async () => {
    const staleJob = makeJob({ id: 'stale-review', pid: 111, kind: 'review', finishedAt: null });
    const activeJob = makeJob({ id: 'active-review', pid: 222, kind: 'review', finishedAt: null });
    mocks.listJobs.mockReturnValue([staleJob, activeJob]);
    mocks.probeJobStatus.mockImplementation((job) => {
      if (job.id === 'active-review') return Promise.resolve('running');
      return Promise.reject(new Error('transient probe failure'));
    });

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('PID 222');
    }
  });

  it('does not return 409 when the "running" review job has actually exited', async () => {
    mocks.listJobs.mockReturnValue([makeJob({ kind: 'review', finishedAt: null })]);
    mocks.probeJobStatus.mockResolvedValue('done');
    mocks.exec.mockResolvedValueOnce(resp(0, ''));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when there are no uncommitted changes', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ''));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No uncommitted changes');
    }
  });

  it('reviews staged changes in the working tree', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'M  lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts b/lib/foo.ts\n+staged change\n'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Working-tree files to review');
    expect(prompt).toContain('- lib/foo.ts');
    expect(prompt).toContain('Working-tree tracked-file diff (vs HEAD)');
  });

  it('runs the project review prerequisite before computing review scope', async () => {
    mocks.loadFileConfig.mockReturnValue({ review_prerequisite_command: 'pnpm run supabase-gen-types' });
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'types generated'))
      .mockResolvedValueOnce(resp(0, 'M  src/lib/database.types.ts'))
      .mockResolvedValueOnce(resp(0, ' src/lib/database.types.ts | 28 ++++++++++++++++++++++++++++\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/src/lib/database.types.ts b/src/lib/database.types.ts\n+web3_nonces\n'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    expect(mocks.exec.mock.calls[0]).toEqual([
      'bash',
      ['-lc', 'pnpm run supabase-gen-types'],
      expect.objectContaining({
        cwd: '/path/to/proj',
        killProcessGroup: true,
      }),
    ]);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('review prerequisite (`pnpm run supabase-gen-types`) — exit 0');
    expect(prompt).toContain('types generated');
    expect(prompt).toContain('web3_nonces');
  });

  it('blocks review when the project review prerequisite fails', async () => {
    mocks.loadFileConfig.mockReturnValue({ review_prerequisite_command: 'pnpm run supabase-gen-types' });
    mocks.exec.mockResolvedValueOnce(resp(1, '', 'type generation failed'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Review prerequisite failed for proj');
      expect(r.detail).toContain('type generation failed');
    }
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('persists autoAttachedDocs on the review job contextMeta when a doc matches', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'M  lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts b/lib/foo.ts\n+x\n'));
    mocks.loadFileConfig.mockReturnValue({});
    mocks.resolveAutoAttachedDocs.mockReturnValue([
      {
        rulePath: 'docs/TEST.md',
        absolutePath: '/path/to/proj/docs/TEST.md',
        name: 'TEST.md',
        content: 'TEST-DOC',
        matchedKeyword: 'test',
      },
    ]);
    mocks.formatAutoAttachedDocsBlock.mockReturnValue('## Auto-attached docs\n\n## TEST.md\nTEST-DOC');

    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    const contextMeta = mocks.createJob.mock.calls[0][5];
    expect(contextMeta).toBeTruthy();
    expect(JSON.parse(contextMeta as string).autoAttachedDocs).toEqual(['docs/TEST.md']);
  });

  it('does not set contextMeta when no auto-attach rules match', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'M  lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts b/lib/foo.ts\n+x\n'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    const contextMeta = mocks.createJob.mock.calls[0][5];
    expect(contextMeta).toBeUndefined();
  });

  it('omits untracked symlink contents from the review prompt', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, '?? secrets-link'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, ''));
    mocks.existsSync.mockImplementation((path: string) => path === '/path/to/proj/secrets-link');
    mocks.lstatSync.mockReturnValue({ isFile: () => false });

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('[untracked file omitted: binary, missing, or unreadable]');
    expect(mocks.readFileSync).not.toHaveBeenCalledWith('/path/to/proj/secrets-link', 'utf-8');
  });

  it('omits non-regular untracked files from the review prompt', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, '?? review.sock'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, ''));
    mocks.existsSync.mockImplementation((path: string) => path === '/path/to/proj/review.sock');
    mocks.lstatSync.mockReturnValue({ isFile: () => false });

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('[untracked file omitted: binary, missing, or unreadable]');
    expect(mocks.readFileSync).not.toHaveBeenCalledWith('/path/to/proj/review.sock', 'utf-8');
  });

  it('returns 400 when only .tamtam changes remain', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ' M .tamtam/agents/improve.md'))
      .mockResolvedValueOnce(resp(0, '0'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No uncommitted changes or unpushed commits');
    }
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('returns 400 when the worktree is clean and there are no unpushed commits', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '0\n'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No uncommitted changes or unpushed commits');
    }
  });

  it('reviews unpushed local commits when the worktree is clean', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '2\n'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    expect(mocks.startJob).toHaveBeenCalled();
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('working tree is clean');
    expect(prompt).toContain('2 local commits not yet pushed');
    expect(prompt).toContain('git diff @{u}..HEAD');
  });

  it('does not narrow local-commit review scope based on a prior PR review job', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '2\n'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(1, '', ''));
    mocks.getSettings.mockReturnValue({ review_verdict_rules: '', incremental_review_enabled: true });
    mocks.listJobs.mockReturnValue([
      makeJob({
        id: 'review-pr',
        finishedAt: Date.now() / 1000,
        exitCode: 0,
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
    ]);

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('2 local commits not yet pushed');
    expect(prompt).toContain('git diff @{u}..HEAD');
    expect(prompt).not.toContain('already approved');
  });

  it('returns 400 when HEAD is exactly the reviewed ref (narrowCount=0) — no new commits to review', async () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc1234';
    mocks.exec
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '2\n'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0, sha + '\n'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '0\n'));
    mocks.getSettings.mockReturnValue({ review_verdict_rules: '', incremental_review_enabled: true });

    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('already approved');
    }
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('narrows review scope to commits since last LGTM when incremental review is enabled', async () => {
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    mocks.exec
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '3\n'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0, sha + '\n'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(0, '1\n'));
    mocks.getSettings.mockReturnValue({ review_verdict_rules: '', incremental_review_enabled: true });

    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('already approved');
    expect(prompt).toContain('1 new commit');
    expect(prompt).toContain(sha.slice(0, 7));
    expect(prompt).not.toContain('@{u}..HEAD');
  });

  it('returns ok with jobId and pid when review starts successfully', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ' M lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts b/lib/foo.ts\n'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('proj-review-id');
      expect(r.pid).toBe(9999);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(mocks.createJob).toHaveBeenCalledWith('proj', 'review', 0, '', undefined, undefined);
    expect(mocks.startJob).toHaveBeenCalled();
  });

  it('passes the full non-.tamtam working-tree scope into the review prompt', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'M  lib/already-reviewed.ts\n M lib/new-fix.ts\n M .tamtam/config.yml'))
      .mockResolvedValueOnce(resp(0, ' lib/already-reviewed.ts | 1 +\n lib/new-fix.ts | 3 ++-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/already-reviewed.ts b/lib/already-reviewed.ts\ndiff --git a/lib/new-fix.ts b/lib/new-fix.ts\n+fixed\n'));

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Review ONLY the non-.tamtam working-tree changes');
    expect(prompt).toContain('- lib/already-reviewed.ts');
    expect(prompt).toContain('- lib/new-fix.ts');
    expect(prompt).toContain('diff --git a/lib/already-reviewed.ts b/lib/already-reviewed.ts');
    expect(prompt).toContain('diff --git a/lib/new-fix.ts b/lib/new-fix.ts');
    expect(prompt).not.toContain('- .tamtam/config.yml');
  });

  it('persists job failure when startJob throws', async () => {
    mocks.startJob.mockRejectedValueOnce(new Error('spawn failed'));
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start review');
    }
    expect(mocks.updateJob).toHaveBeenCalledOnce();
    const savedJob = mocks.updateJob.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('acquires pipeline lock after successful job start when not under release', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    await startProjectReview('proj');
    expect(mocks.acquireLock).toHaveBeenCalledWith('proj', 'proj-review-id');
  });

  it('does not acquire pipeline lock when running under active release', async () => {
    mocks.isLockOwnedByActiveRelease.mockReturnValue(true);
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    await startProjectReview('proj');
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it('passes project name and path into the prompt', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('proj');
    expect(prompt).toContain('/path/to/proj');
  });

  it('injects review_verdict_rules into the prompt', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Use LGTM / NEEDS ATTENTION / DO NOT SHIP.');
  });

  it('requires structured findings with blast-radius review context', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));
    await startProjectReview('proj');
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Finding ID: stable-kebab-case-id');
    expect(prompt).toContain('Root cause:');
    expect(prompt).toContain('Affected paths:');
    expect(prompt).toContain('Documentation:');
    expect(prompt).toContain('Required tests:');
    expect(prompt).toContain('blast-radius checklist');
    expect(prompt).toContain('alternate routes or background jobs');
    expect(prompt).toContain('docs/*.md');
    expect(prompt).toContain('Do not require docs for trivial refactors');
  });

  it('includes prior release review, fix, and host-test context in follow-up reviews', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'release-1', kind: 'release', finishedAt: null, startedAt: 10 }),
      makeJob({ id: 'prev-review', kind: 'review', releaseId: 'release-1', finishedAt: 20, startedAt: 20, exitCode: 0 }),
      makeJob({ id: 'prev-fix', kind: 'fix', releaseId: 'release-1', finishedAt: 30, startedAt: 30, exitCode: 0 }),
      // Host-side test run after the review-driven fix (review → fix → test → review).
      // Plain test output (no stream-json) — readParsedLog returns it raw.
      makeJob({ id: 'prev-test', kind: 'test', releaseId: 'release-1', finishedAt: 40, startedAt: 40, exitCode: 1 }),
    ]);
    mocks.readLog.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review') {
        return '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Findings:\\n- Finding ID: shared-server-validation\\n  Root cause: server route bypass\\nVerdict: DO NOT SHIP"}}}';
      }
      if (job.id === 'prev-fix') {
        return '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Fix checklist:\\n- Finding ID: shared-server-validation\\n  Status: fixed"}}}';
      }
      return '';
    });
    mocks.readParsedLog.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review') {
        return 'Findings:\n- Finding ID: shared-server-validation\n  Root cause: server route bypass\nVerdict: DO NOT SHIP\n';
      }
      if (job.id === 'prev-test') {
        return 'FAIL src/lib/api/submissions.integration.test.ts\n  × should enforce rolling frequency windows\nTest Files  1 failed\n     Tests  1 failed | 96 passed';
      }
      return 'Fix checklist:\n- Finding ID: shared-server-validation\n  Status: fixed\n';
    });
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));

    await startProjectReview('proj');

    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('PREVIOUS RELEASE REVIEW/FIX/TEST CONTEXT');
    expect(prompt).toContain('prev-review');
    expect(prompt).toContain('shared-server-validation');
    expect(prompt).toContain('First verify whether earlier findings were actually fixed');
    // The host test result must feed into review so it knows what the fix broke.
    expect(prompt).toContain('prev-test');
    expect(prompt).toContain('should enforce rolling frequency windows');
    expect(prompt).toContain('1 failed | 96 passed');
    expect(prompt).not.toContain('"type":"stream_event"');
    expect(mocks.readParsedLog).toHaveBeenCalledWith(expect.objectContaining({ id: 'prev-review' }));
    expect(mocks.readParsedLog).toHaveBeenCalledWith(expect.objectContaining({ id: 'prev-fix' }));
    expect(mocks.readParsedLog).toHaveBeenCalledWith(expect.objectContaining({ id: 'prev-test' }));
  });

  it('uses the newest active release for prior review and fix context', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'older-release', kind: 'release', finishedAt: null, startedAt: 10 }),
      makeJob({ id: 'older-review', kind: 'review', releaseId: 'older-release', finishedAt: 20, startedAt: 20, exitCode: 0 }),
      makeJob({ id: 'newer-release', kind: 'release', finishedAt: null, startedAt: 50 }),
      makeJob({ id: 'newer-review', kind: 'review', releaseId: 'newer-release', finishedAt: 60, startedAt: 60, exitCode: 0 }),
    ]);
    mocks.readParsedLog.mockImplementation((job: { id: string }) => {
      if (job.id === 'older-review') {
        return 'Findings:\n- Finding ID: stale-release-context\n  Root cause: old release\n';
      }
      return 'Findings:\n- Finding ID: newest-release-context\n  Root cause: current release\n';
    });
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));

    await startProjectReview('proj');

    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('newer-review');
    expect(prompt).toContain('newest-release-context');
    expect(prompt).not.toContain('older-review');
    expect(prompt).not.toContain('stale-release-context');
  });

  it('does not surface incidental id lines as findings in prior release context', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({ id: 'release-2', kind: 'release', finishedAt: null, startedAt: 10 }),
      makeJob({ id: 'prev-review-2', kind: 'review', releaseId: 'release-2', finishedAt: 20, startedAt: 20, exitCode: 0 }),
      makeJob({ id: 'prev-fix-2', kind: 'fix', releaseId: 'release-2', finishedAt: 30, startedAt: 30, exitCode: 0 }),
    ]);
    mocks.readParsedLog.mockImplementation((job: { id: string }) => {
      if (job.id === 'prev-review-2') {
        return 'Findings:\n- Finding ID: shared-server-validation\n  Root cause: server route bypass\nVerdict: DO NOT SHIP\n';
      }
      return 'Fix checklist:\n- Root cause: updated cache flush path\n  id: shared-placeholder\n';
    });
    mocks.exec.mockResolvedValueOnce(resp(0, ' M lib/foo.ts'));

    await startProjectReview('proj');

    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('prev-review-2');
    expect(prompt).toContain('shared-server-validation');
    expect(prompt).not.toContain(', findings shared-placeholder');
  });

  it('only checks running jobs of kind "review" (ignores other kinds)', async () => {
    mocks.listJobs.mockReturnValue([
      makeJob({ kind: 'fix', finishedAt: null }),
      makeJob({ kind: 'test', finishedAt: null }),
    ]);
    mocks.probeJobStatus.mockResolvedValue('running');
    mocks.exec.mockResolvedValueOnce(resp(0, ''));
    const r = await startProjectReview('proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('appends reviewPromptAddendum to the review prompt when configured', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'M lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts\n+change\n'));
    mocks.getProjectPipelinePrompts.mockResolvedValue({
      reviewPromptAddendum: 'Focus on security issues.',
      reviewPrerequisiteCommand: null,
      fixPromptAddendum: null,
    });

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Project-specific review guidance');
    expect(prompt).toContain('Focus on security issues.');
  });

  it('runs reviewPrerequisiteCommand before detecting review scope and includes output in the prompt', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, 'generated types\n'))
      .mockResolvedValueOnce(resp(0, 'M lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, ' lib/foo.ts | 2 +-\n'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts\n+change\n'));
    mocks.getProjectPipelinePrompts.mockResolvedValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: 'pnpm db:types',
      fixPromptAddendum: null,
    });

    const r = await startProjectReview('proj');

    expect(r.ok).toBe(true);
    expect(mocks.exec.mock.calls[0]).toEqual([
      'bash',
      ['-lc', 'pnpm db:types'],
      { cwd: '/path/to/proj', timeout: 20 * 60 * 1000, killProcessGroup: true, scrubSecrets: true },
    ]);
    expect(mocks.exec.mock.calls[1][1]).toEqual(['-C', '/path/to/proj', 'status', '--porcelain', '--ignore-submodules']);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('# review prerequisite (`pnpm db:types`)');
    expect(prompt).toContain('generated types');
  });

  it('blocks reviewPrerequisiteCommand on an untrusted non-default branch before executing it', async () => {
    mocks.getProjectPipelinePrompts.mockResolvedValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: 'pnpm db:types',
      fixPromptAddendum: null,
    });
    mocks.checkPrBranchExecutionGate.mockReturnValue({
      ok: false,
      detail: 'Refusing to run review prerequisite on non-default branch feature: untrusted author.',
    });

    const r = await startProjectReview('proj');

    expect(r).toEqual({
      ok: false,
      status: 409,
      detail: 'Refusing to run review prerequisite on non-default branch feature: untrusted author.',
    });
    expect(mocks.checkPrBranchExecutionGate).toHaveBeenCalledWith(
      '/path/to/proj',
      'run review prerequisite',
      { allowTrustedLocalChanges: false },
    );
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('does not inject acceptance criteria into the review prompt — DoD verification is mark-dod\'s job', async () => {
    mocks.exec
      .mockResolvedValueOnce(resp(0, ' M lib/foo.ts'))
      .mockResolvedValueOnce(resp(0, '1 file changed'))
      .mockResolvedValueOnce(resp(0, 'diff --git a/lib/foo.ts\n+change\n'));

    await startProjectReview('proj');

    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).not.toContain('ACCEPTANCE CRITERIA:');
    expect(prompt).not.toContain('Verified criteria');
  });
});

describe('startProjectReview — default skill path', () => {
  it('loads the vendored code reviewer skill from the default path', async () => {
    mocks.codeReviewerSkillPath = '/abs/path/skills/docs/skills/engineering/code-reviewer.md';
    mocks.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M lib/foo.ts', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1 file changed', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git a/lib/foo.ts\n+change\n', stderr: '' });
    mocks.readFileSync.mockReturnValue('Vendored reviewer skill body.');

    const result = await startProjectReview('proj');

    expect(result.ok).toBe(true);
    expect(mocks.readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/skills\/docs\/skills\/engineering\/code-reviewer\.md$/),
      'utf-8',
    );
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('Vendored reviewer skill body.');
  });

  it('injects detected frameworks and filters working-tree review framework checklists', async () => {
    const skillPath = '/abs/path/skills/docs/skills/engineering/code-reviewer.md';
    const skillBody = [
      'Before checks.',
      '',
      '## Framework-specific checks',
      '',
      'The pipeline pre-filters this section to the project detected stack.',
      '',
      '### Next.js (App Router) — apply when the pipeline-injected `FRAMEWORK:` line includes `nextjs`',
      '',
      '- Next-only rule.',
      '',
      '### Python — apply when the pipeline-injected `FRAMEWORK:` line includes `python`',
      '',
      '- Python-only rule.',
      '',
      '## Output format',
      '',
      'End correctly.',
    ].join('\n');
    mocks.codeReviewerSkillPath = skillPath;
    mocks.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M lib/foo.ts', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '1 file changed', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git a/lib/foo.ts\n+change\n', stderr: '' });
    mocks.existsSync.mockImplementation((path: string) =>
      path === skillPath || path === '/path/to/proj/package.json'
    );
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/path/to/proj/package.json') return JSON.stringify({ dependencies: { next: '^16.2.4' } });
      return skillBody;
    });
    mocks.loadFileConfig.mockReturnValue(null);
    mocks.resolveAutoAttachedDocs.mockReturnValue([]);
    mocks.formatAutoAttachedDocsBlock.mockReturnValue(null);

    const result = await startProjectReview('proj');

    expect(result.ok).toBe(true);
    const prompt: string = mocks.startJob.mock.calls[0][2];
    expect(prompt).toContain('FRAMEWORK: nextjs@16.2.4.');
    expect(prompt).toContain('### Next.js (App Router)');
    expect(prompt).toContain('- Next-only rule.');
    expect(prompt).not.toContain('### Python');
    expect(prompt).not.toContain('- Python-only rule.');
    expect(prompt).toContain('## Output format');
  });
});
