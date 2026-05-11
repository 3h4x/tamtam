import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('startPrReview', () => {
  let startPrReview: typeof import('@/lib/pipeline/start-pr-review').startPrReview;
  let execMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function makeJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'review-job-1', project: 'proj', kind: 'review', pid: 0, logPath: null,
      prompt: null, startedAt: Date.now() / 1000, finishedAt: null, exitCode: null, seen: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(9999);
    updateJobMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');

    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    }));

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: 'Use LGTM / NEEDS ATTENTION / DO NOT SHIP.' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
    }));
    vi.doMock('@/lib/skills/skills', () => ({
      CODE_REVIEWER_SKILL: '/nonexistent/code-reviewer.md',
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    ({ startPrReview } = await import('@/lib/pipeline/start-pr-review'));
  });

  afterEach(() => vi.resetModules());

  it('returns 404 when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]), probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: '' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '',
    }));
    vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/nonexistent/path' }));
    vi.doMock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    const { startPrReview: fn } = await import('@/lib/pipeline/start-pr-review');
    const r = await fn('missing', 42, 'Fix bug', 'fix/42', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 409 when a review is already running for the project', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already in progress');
    }
  });

  it('does not return 409 when the "running" review has actually exited', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('done');
    // diff returns empty — gets a 400 from no-diff check
    execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when gh pr diff returns empty output', async () => {
    execMock.mockResolvedValueOnce(resp(0, '   \n'));
    const r = await startPrReview('proj', 7, 'Some PR', 'fix/7', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No diff found for PR #7');
    }
  });

  it('returns ok with jobId and pid when PR review starts successfully', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts\n+added'));
    const r = await startPrReview('proj', 42, 'Fix everything', 'fix/42', 'main');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('proj-review-id');
      expect(r.pid).toBe(9999);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
    expect(startJobMock).toHaveBeenCalled();
  });

  it('creates a review job with kind "review"', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
  });

  it('persists job failure when startJob throws', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    startJobMock.mockRejectedValueOnce(new Error('spawn failed'));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start PR review');
    }
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('substitutes PR metadata into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/file.ts b/file.ts'));
    await startPrReview('proj', 99, 'My PR Title', 'feature/my-branch', 'develop');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('proj');
    expect(prompt).toContain('/path/to/proj');
    expect(prompt).toContain('99');
    expect(prompt).toContain('My PR Title');
    expect(prompt).toContain('feature/my-branch');
    expect(prompt).toContain('develop');
  });

  it('injects the diff into the prompt', async () => {
    const diffText = 'diff --git a/foo.ts b/foo.ts\n+new line';
    execMock.mockResolvedValueOnce(resp(0, diffText));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain(diffText);
  });

  it('injects review_verdict_rules into the prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Use LGTM / NEEDS ATTENTION / DO NOT SHIP.');
  });

  it('tells reviewers to ignore TamTam internal config changes', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/.tamtam/config.yml b/.tamtam/config.yml'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('TAMTAM INTERNAL CONFIG CONTEXT');
    expect(prompt).toContain('Ignore `.tamtam/` changes during review');
    expect(prompt).toContain('`.tamtam/agents/*.md`, `.tamtam/config.yml`, or other `.tamtam/` files');
  });

  it('only checks review-kind running jobs (ignores fix/test)', async () => {
    listJobsMock.mockReturnValue([
      makeJob({ kind: 'fix', finishedAt: null }),
      makeJob({ kind: 'test', finishedAt: null }),
    ]);
    probeJobStatusMock.mockResolvedValue('running');
    execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    // Should not return 409 — only review-kind jobs are checked
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('invokes gh pr diff with the correct PR number', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 123, 'Title', 'feat/123', 'main');
    expect(execMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '123'],
      expect.objectContaining({ cwd: '/path/to/proj' })
    );
  });

  it('updates the job with logPath and pid after successful start', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.pid).toBe(9999);
    expect(savedJob.logPath).toMatch(/\.log$/);
    expect(JSON.parse(savedJob.contextMeta)).toMatchObject({ sourceType: 'pr_review', prNumber: 1 });
  });

  it('returns 400 when gh pr diff exits non-zero with no stdout', async () => {
    execMock.mockResolvedValueOnce(resp(1, '', 'gh: not found'));
    const r = await startPrReview('proj', 5, 'Title', 'feat/5', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No diff found for PR #5');
    }
  });

  it('passes --allowed-tools Read,Grep,Glob to restrict PR review to read-only tools', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const command: string = startJobMock.mock.calls[0][1];
    expect(command).toContain('--allowed-tools');
    expect(command).toContain('Read');
    expect(command).toContain('Grep');
    expect(command).toContain('Glob');
    expect(command).not.toContain('Bash');
  });

  it('wraps pr title in untrusted tags', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Malicious PR Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_title">');
    expect(prompt).toContain('Malicious PR Title');
  });

  it('wraps diff in untrusted tags', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_diff">');
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
  });

  it('wraps branch refs in untrusted tags', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_ref">');
    expect(prompt).toContain('feat/1');
    expect(prompt).toContain('main');
  });

  it('prepends untrusted system instruction to the PR review prompt', async () => {
    execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('SECURITY:');
    expect(prompt.indexOf('SECURITY:')).toBeLessThan(prompt.indexOf('feat/1'));
  });
});

describe('loadReviewPrompt — skill file handling', () => {
  let startPrReview: typeof import('@/lib/pipeline/start-pr-review').startPrReview;
  let execMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let readFileSyncMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  async function setup(fileContent: string | null, options: { useDefaultSkillPath?: boolean } = {}) {
    vi.resetModules();
    execMock = vi.fn().mockResolvedValue(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    startJobMock = vi.fn().mockResolvedValue(1234);
    existsSyncMock = options.useDefaultSkillPath
      ? vi.fn((path: string) => fileContent !== null && path.endsWith('/skills/docs/skills/engineering/code-reviewer.md'))
      : vi.fn().mockReturnValue(fileContent !== null);
    readFileSyncMock = vi.fn().mockReturnValue(fileContent ?? '');

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/proj'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn().mockImplementation((project: string, kind: string) => ({
        id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
        prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      })),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ review_verdict_rules: 'VERDICT_RULES' }),
      withBasePrompt: (s: string) => s,
      getPermissionModeFlag: () => '',
    }));
    if (options.useDefaultSkillPath) {
      vi.doMock('@/lib/skills/skills', async () => (
        await vi.importActual<typeof import('@/lib/skills/skills')>('@/lib/skills/skills')
      ));
    } else {
      vi.doMock('@/lib/skills/skills', () => ({ CODE_REVIEWER_SKILL: '/skill/code-reviewer.md' }));
    }
    vi.doMock('fs', () => ({ existsSync: existsSyncMock, readFileSync: readFileSyncMock, mkdirSync: vi.fn(), appendFileSync: vi.fn() }));

    ({ startPrReview } = await import('@/lib/pipeline/start-pr-review'));
  }

  afterEach(() => vi.resetModules());

  it('includes skill file content in the prompt when the file exists (no frontmatter)', async () => {
    await setup('This is the review skill content.');
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('This is the review skill content.');
  });

  it('loads the vendored code reviewer skill from the default path', async () => {
    await setup('Vendored reviewer skill body.', { useDefaultSkillPath: true });
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(existsSyncMock).toHaveBeenCalledWith(expect.stringMatching(/skills\/docs\/skills\/engineering\/code-reviewer\.md$/));
    expect(prompt).toContain('Vendored reviewer skill body.');
  });

  it('strips YAML frontmatter when skill file starts with ---', async () => {
    await setup('---\ntitle: Code Reviewer\ndescription: Reviews code\n---\n\nActual skill body here.');
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Actual skill body here.');
    expect(prompt).not.toContain('title: Code Reviewer');
    expect(prompt).not.toContain('description: Reviews code');
  });

  it('keeps the full content when file starts with --- but has no closing ---', async () => {
    const content = '---\ntitle: Incomplete frontmatter\nno closing fence';
    await setup(content);
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    expect(prompt).toContain('---\ntitle: Incomplete frontmatter\nno closing fence');
  });

  it('produces no skill content in prompt when file does not exist', async () => {
    await setup(null);
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = startJobMock.mock.calls[0][2];
    // Prompt starts with the untrusted system instruction (no skill preamble)
    expect(prompt.trimStart()).toContain('SECURITY:');
    // No skill body content
    expect(prompt).not.toContain('This is the review skill content.');
  });
});
