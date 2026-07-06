import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mock factories. Top-level vi.mock() with replace-impl-per-test
// is dramatically faster than vi.resetModules() + vi.doMock() + dynamic import
// in every beforeEach (~720ms → see verify step in commit).
// ─────────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  return {
    execMock: vi.fn(),
    resolveProjectPathMock: vi.fn(),
    createJobMock: vi.fn(),
    updateJobMock: vi.fn(),
    listJobsMock: vi.fn(),
    probeJobStatusMock: vi.fn(),
    startJobMock: vi.fn(),
    getSettingsMock: vi.fn(),
    checkCliStartGateMock: vi.fn(),
    codeReviewerSkillRef: { value: '/nonexistent/code-reviewer.md' as string },
    existsSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    resolveGhRepoMock: vi.fn(),
    fetchPrReviewIssueContextMock: vi.fn(),
  };
});

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPathMock,
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: mocks.createJobMock,
  updateJob: mocks.updateJobMock,
  listJobs: mocks.listJobsMock,
  probeJobStatus: mocks.probeJobStatusMock,
}));
vi.mock('@/lib/jobs/spawn-claude-detached', () => ({ startJobInProcess: mocks.startJobMock }));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: mocks.checkCliStartGateMock,
}));
vi.mock('@/lib/shared/config', () => ({
  getSettings: () => mocks.getSettingsMock(),
  withBasePrompt: (s: string) => s,
  getPermissionModeFlag: () => '--dangerously-skip-permissions',
}));
// CODE_REVIEWER_SKILL is read at call-time inside loadReviewPrompt(), so we can
// keep a single mocked module and mutate the exported binding via a getter.
vi.mock('@/lib/skills/skills', () => ({
  get CODE_REVIEWER_SKILL() {
    return mocks.codeReviewerSkillRef.value;
  },
}));
vi.mock('fs', () => ({
  existsSync: mocks.existsSyncMock,
  readFileSync: mocks.readFileSyncMock,
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));
// Stub out the file-config loader so anything reaching wrapIfUntrusted /
// getBranchContext does not shell out to `git` (via execFileSync) — each
// real git invocation against a non-existent project path costs ~10ms.
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
}));
vi.mock('@/lib/github/repo', () => ({
  resolveGhRepo: mocks.resolveGhRepoMock,
}));
vi.mock('@/lib/pipeline/pr-review-issue-context', () => ({
  fetchPrReviewIssueContext: mocks.fetchPrReviewIssueContextMock,
}));

// Single top-level import — all tests share this resolved module graph.
import { startPrReview } from '@/lib/pipeline/start-pr-review';

describe('startPrReview', () => {
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

  beforeEach(() => {
    for (const m of Object.values(mocks)) {
      if (typeof (m as { mockReset?: () => void }).mockReset === 'function') {
        (m as { mockReset: () => void }).mockReset();
      }
    }
    mocks.codeReviewerSkillRef.value = '/nonexistent/code-reviewer.md';
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.readFileSyncMock.mockReturnValue('');
    mocks.resolveProjectPathMock.mockReturnValue('/path/to/proj');
    mocks.startJobMock.mockResolvedValue(9999);
    mocks.listJobsMock.mockReturnValue([]);
    mocks.probeJobStatusMock.mockResolvedValue('done');
    mocks.getSettingsMock.mockReturnValue({ review_verdict_rules: 'Use LGTM / NEEDS ATTENTION / DO NOT SHIP.' });
    mocks.checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'claude' });
    // Default: no issue context injected (keeps existing prompt assertions intact).
    mocks.resolveGhRepoMock.mockResolvedValue(null);
    mocks.fetchPrReviewIssueContextMock.mockResolvedValue(null);
    mocks.createJobMock.mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('injects linked-issue acceptance criteria and the verified-criteria contract when the PR closes an issue', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    mocks.resolveGhRepoMock.mockResolvedValue('owner/repo');
    mocks.fetchPrReviewIssueContextMock.mockResolvedValue({ issueNumber: 10, criteria: ['Add unit tests', 'Handle errors'] });

    await startPrReview('proj', 42, 'Title', 'feat/42', 'main');

    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('issue #10');
    expect(prompt).toContain('Add unit tests');
    expect(prompt).toContain('Handle errors');
    // The verified-criteria output contract must be appended so the reviewer emits
    // a `## Verified criteria` section the completion hook can gate the merge on.
    expect(prompt).toContain('## Verified criteria');
    expect(prompt).toContain('<untrusted source="github_issue_acceptance_criteria">');
    // Fetches criteria against the resolved repo + this PR number.
    expect(mocks.fetchPrReviewIssueContextMock).toHaveBeenCalledWith('/path/to/proj', 'owner/repo', 42);
    // Issue number stamped so post-merge DoD can target the issue.
    const savedJob = mocks.updateJobMock.mock.calls[0][0];
    expect(JSON.parse(savedJob.contextMeta)).toMatchObject({ sourceType: 'pr_review', prNumber: 42, issueNumber: 10 });
  });

  it('does not inject the verified-criteria contract when the PR has no linked issue', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    mocks.resolveGhRepoMock.mockResolvedValue('owner/repo');
    mocks.fetchPrReviewIssueContextMock.mockResolvedValue(null);

    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');

    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).not.toContain('## Verified criteria');
    expect(prompt).not.toContain('ACCEPTANCE CRITERIA');
  });

  it('returns 404 when project path cannot be resolved', async () => {
    mocks.resolveProjectPathMock.mockReturnValue(null);
    const r = await startPrReview('missing', 42, 'Fix bug', 'fix/42', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('missing');
    }
  });

  it('returns 409 when a review is already running for the project', async () => {
    mocks.listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    mocks.probeJobStatusMock.mockResolvedValue('running');
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.detail).toContain('already in progress');
    }
  });

  it('does not return 409 when the "running" review has actually exited', async () => {
    mocks.listJobsMock.mockReturnValue([
      makeJob({ kind: 'review', finishedAt: null }),
    ]);
    mocks.probeJobStatusMock.mockResolvedValue('done');
    // diff returns empty — gets a 400 from no-diff check
    mocks.execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when gh pr diff returns empty output', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, '   \n'));
    const r = await startPrReview('proj', 7, 'Some PR', 'fix/7', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No diff found for PR #7');
    }
  });

  it('returns ok with jobId and pid when PR review starts successfully', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts\n+added'));
    const r = await startPrReview('proj', 42, 'Fix everything', 'fix/42', 'main');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBe('proj-review-id');
      expect(r.pid).toBe(9999);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(mocks.createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
    expect(mocks.startJobMock).toHaveBeenCalled();
  });

  it('creates a review job with kind "review"', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(mocks.createJobMock).toHaveBeenCalledWith('proj', 'review', 0, '');
  });

  it('persists job failure when startJob throws', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    mocks.startJobMock.mockRejectedValueOnce(new Error('spawn failed'));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('Failed to start PR review');
    }
    expect(mocks.updateJobMock).toHaveBeenCalledOnce();
    const savedJob = mocks.updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('substitutes PR metadata into the prompt', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/file.ts b/file.ts'));
    await startPrReview('proj', 99, 'My PR Title', 'feature/my-branch', 'develop');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('proj');
    expect(prompt).toContain('/path/to/proj');
    expect(prompt).toContain('99');
    expect(prompt).toContain('My PR Title');
    expect(prompt).toContain('feature/my-branch');
    expect(prompt).toContain('develop');
  });

  it('injects the diff into the prompt', async () => {
    const diffText = 'diff --git a/foo.ts b/foo.ts\n+new line';
    mocks.execMock.mockResolvedValueOnce(resp(0, diffText));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain(diffText);
  });

  it('injects review_verdict_rules into the prompt', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Use LGTM / NEEDS ATTENTION / DO NOT SHIP.');
  });

  it('tells reviewers to ignore TamTam internal config changes', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/.tamtam/config.yml b/.tamtam/config.yml'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('TAMTAM INTERNAL CONFIG CONTEXT');
    expect(prompt).toContain('Ignore `.tamtam/` changes during review');
    expect(prompt).toContain('`.tamtam/agents/*.md`, `.tamtam/config.yml`, or other `.tamtam/` files');
  });

  it('only checks review-kind running jobs (ignores fix/test)', async () => {
    mocks.listJobsMock.mockReturnValue([
      makeJob({ kind: 'fix', finishedAt: null }),
      makeJob({ kind: 'test', finishedAt: null }),
    ]);
    mocks.probeJobStatusMock.mockResolvedValue('running');
    mocks.execMock.mockResolvedValueOnce(resp(0, ''));
    const r = await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    // Should not return 409 — only review-kind jobs are checked
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('invokes gh pr diff with the correct PR number', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 123, 'Title', 'feat/123', 'main');
    expect(mocks.execMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '123'],
      expect.objectContaining({ cwd: '/path/to/proj' })
    );
  });

  it('updates the job with logPath and pid after successful start', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    expect(mocks.updateJobMock).toHaveBeenCalledOnce();
    const savedJob = mocks.updateJobMock.mock.calls[0][0];
    expect(savedJob.pid).toBe(9999);
    expect(savedJob.logPath).toMatch(/\.log$/);
    expect(JSON.parse(savedJob.contextMeta)).toMatchObject({ sourceType: 'pr_review', prNumber: 1 });
  });

  it('returns 400 when gh pr diff exits non-zero with no stdout', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(1, '', 'gh: not found'));
    const r = await startPrReview('proj', 5, 'Title', 'feat/5', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('No diff found for PR #5');
    }
  });

  it('passes --allowed-tools Read,Grep,Glob to restrict PR review to read-only tools', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const command: string = mocks.startJobMock.mock.calls[0][1];
    expect(command).toContain('--allowed-tools');
    expect(command).toContain('Read');
    expect(command).toContain('Grep');
    expect(command).toContain('Glob');
    expect(command).not.toContain('Bash');
  });

  it('wraps pr title in untrusted tags', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Malicious PR Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_title">');
    expect(prompt).toContain('Malicious PR Title');
  });

  it('wraps diff in untrusted tags', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_diff">');
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
  });

  it('wraps branch refs in untrusted tags', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('<untrusted source="github_pr_ref">');
    expect(prompt).toContain('feat/1');
    expect(prompt).toContain('main');
  });

  it('prepends untrusted system instruction to the PR review prompt', async () => {
    mocks.execMock.mockResolvedValueOnce(resp(0, 'diff content'));
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('SECURITY:');
    expect(prompt.indexOf('SECURITY:')).toBeLessThan(prompt.indexOf('feat/1'));
  });
});

describe('loadReviewPrompt — skill file handling', () => {
  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function setupSkill(fileContent: string | null, options: { useDefaultSkillPath?: boolean; packageJson?: string } = {}) {
    for (const m of Object.values(mocks)) {
      if (typeof (m as { mockReset?: () => void }).mockReset === 'function') {
        (m as { mockReset: () => void }).mockReset();
      }
    }
    mocks.resolveProjectPathMock.mockReturnValue('/proj');
    mocks.execMock.mockResolvedValue(resp(0, 'diff --git a/foo.ts b/foo.ts'));
    mocks.startJobMock.mockResolvedValue(1234);
    mocks.listJobsMock.mockReturnValue([]);
    mocks.probeJobStatusMock.mockResolvedValue('done');
    mocks.getSettingsMock.mockReturnValue({ review_verdict_rules: 'VERDICT_RULES' });
    mocks.checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'claude' });
    mocks.resolveGhRepoMock.mockResolvedValue(null);
    mocks.fetchPrReviewIssueContextMock.mockResolvedValue(null);
    mocks.createJobMock.mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
    }));

    if (options.useDefaultSkillPath) {
      // Restore the real CODE_REVIEWER_SKILL constant for this test only by
      // resolving it through a separate dynamic import — but we re-mocked the
      // module, so resolve it lazily via require of the actual file path.
      // Easier: hardcode the expected suffix and let existsSync match on it.
      mocks.codeReviewerSkillRef.value = '/abs/path/skills/docs/skills/engineering/code-reviewer.md';
      mocks.existsSyncMock.mockImplementation((p: string) => {
        if (options.packageJson && p === '/proj/package.json') return true;
        return fileContent !== null && p.endsWith('/skills/docs/skills/engineering/code-reviewer.md');
      });
    } else {
      mocks.codeReviewerSkillRef.value = '/skill/code-reviewer.md';
      mocks.existsSyncMock.mockImplementation((p: string) => {
        if (options.packageJson && p === '/proj/package.json') return true;
        return fileContent !== null && p === '/skill/code-reviewer.md';
      });
    }
    mocks.readFileSyncMock.mockImplementation((p: string) => {
      if (options.packageJson && p === '/proj/package.json') return options.packageJson;
      if (fileContent === null) throw new Error(`ENOENT: ${p}`);
      return fileContent ?? '';
    });
  }

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('includes skill file content in the prompt when the file exists (no frontmatter)', async () => {
    setupSkill('This is the review skill content.');
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('This is the review skill content.');
  });

  it('loads the vendored code reviewer skill from the default path', async () => {
    setupSkill('Vendored reviewer skill body.', { useDefaultSkillPath: true });
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(mocks.readFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/skills\/docs\/skills\/engineering\/code-reviewer\.md$/),
      'utf-8',
    );
    expect(prompt).toContain('Vendored reviewer skill body.');
  });

  it('strips YAML frontmatter when skill file starts with ---', async () => {
    setupSkill('---\ntitle: Code Reviewer\ndescription: Reviews code\n---\n\nActual skill body here.');
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('Actual skill body here.');
    expect(prompt).not.toContain('title: Code Reviewer');
    expect(prompt).not.toContain('description: Reviews code');
  });

  it('keeps the full content when file starts with --- but has no closing ---', async () => {
    setupSkill('---\ntitle: Incomplete frontmatter\nno closing fence');
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('---\ntitle: Incomplete frontmatter\nno closing fence');
  });

  it('injects detected frameworks and filters PR review framework checklists', async () => {
    setupSkill(
      [
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
      ].join('\n'),
      { packageJson: JSON.stringify({ dependencies: { next: '^16.2.4' } }) },
    );

    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');

    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    expect(prompt).toContain('FRAMEWORK: nextjs@16.2.4.');
    expect(prompt).toContain('### Next.js (App Router)');
    expect(prompt).toContain('- Next-only rule.');
    expect(prompt).not.toContain('### Python');
    expect(prompt).not.toContain('- Python-only rule.');
    expect(prompt).toContain('## Output format');
  });

  it('produces no skill content in prompt when file does not exist', async () => {
    setupSkill(null);
    await startPrReview('proj', 1, 'Title', 'feat/1', 'main');
    const prompt: string = mocks.startJobMock.mock.calls[0][2];
    // Prompt starts with the untrusted system instruction (no skill preamble)
    expect(prompt.trimStart()).toContain('SECURITY:');
    // No skill body content
    expect(prompt).not.toContain('This is the review skill content.');
  });
});
