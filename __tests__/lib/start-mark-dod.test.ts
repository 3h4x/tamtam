import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractCriteria, tickCriteria } from '@/lib/pipeline/mark-dod-criteria';

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('extractCriteria', () => {
  it('returns empty array when body has no checkboxes', () => {
    expect(extractCriteria('No checkboxes here\nJust text')).toEqual([]);
  });

  it('extracts unchecked `- [ ]` lines', () => {
    const body = '- [ ] First criterion\n- [ ] Second criterion';
    const result = extractCriteria(body);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('First criterion');
    expect(result[1].text).toBe('Second criterion');
  });

  it('extracts unchecked `* [ ]` lines', () => {
    const body = '* [ ] Criterion with asterisk';
    const result = extractCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Criterion with asterisk');
  });

  it('ignores already-checked `- [x]` lines', () => {
    const body = '- [x] Already done\n- [ ] Still todo';
    const result = extractCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Still todo');
  });

  it('ignores already-checked `- [X]` lines (uppercase)', () => {
    const body = '- [X] Done uppercase\n- [ ] Not done';
    const result = extractCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Not done');
  });

  it('handles indented checkboxes', () => {
    const body = '  - [ ] Indented criterion';
    const result = extractCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Indented criterion');
  });

  it('preserves raw line on each entry', () => {
    const body = '- [ ] My criterion';
    const result = extractCriteria(body);
    expect(result[0].raw).toBe('- [ ] My criterion');
  });

  it('trims trailing whitespace from criterion text', () => {
    const body = '- [ ] Has trailing spaces   ';
    const result = extractCriteria(body);
    expect(result[0].text).toBe('Has trailing spaces');
  });
});

describe('tickCriteria', () => {
  it('replaces `- [ ]` with `- [x]` for verified criterion', () => {
    const body = '- [ ] Add unit tests';
    const { body: out, ticked } = tickCriteria(body, new Set(['Add unit tests']));
    expect(out).toBe('- [x] Add unit tests');
    expect(ticked).toBe(1);
  });

  it('leaves unverified lines unchanged', () => {
    const body = '- [ ] Not verified';
    const { body: out, ticked } = tickCriteria(body, new Set(['Other thing']));
    expect(out).toBe('- [ ] Not verified');
    expect(ticked).toBe(0);
  });

  it('ticks only verified lines when mixed', () => {
    const body = '- [ ] Verified A\n- [ ] Not verified\n- [ ] Verified B';
    const { body: out, ticked } = tickCriteria(body, new Set(['Verified A', 'Verified B']));
    expect(out).toBe('- [x] Verified A\n- [ ] Not verified\n- [x] Verified B');
    expect(ticked).toBe(2);
  });

  it('does not tick already-checked lines', () => {
    const body = '- [x] Already checked';
    const { body: out, ticked } = tickCriteria(body, new Set(['Already checked']));
    expect(out).toBe('- [x] Already checked');
    expect(ticked).toBe(0);
  });

  it('works with `* [ ]` bullets', () => {
    const body = '* [ ] Star bullet criterion';
    const { body: out, ticked } = tickCriteria(body, new Set(['Star bullet criterion']));
    expect(out).toBe('* [x] Star bullet criterion');
    expect(ticked).toBe(1);
  });

  it('returns ticked=0 and unchanged body when verifiedTexts is empty', () => {
    const body = '- [ ] Something\n- [ ] Another';
    const { body: out, ticked } = tickCriteria(body, new Set());
    expect(out).toBe(body);
    expect(ticked).toBe(0);
  });
});

// ─── startMarkDod ─────────────────────────────────────────────────────────────

// Hoisted mock factories so module-level vi.mock can reference stable fns.
// Mocking at module scope (rather than vi.doMock + vi.resetModules in
// beforeEach) lets every test reuse the same compiled module graph for
// start-mark-dod and its deps, which is much faster than rebuilding the
// graph per test.
const mocks = vi.hoisted(() => {
  const execMock = vi.fn();
  const listJobsMock = vi.fn();
  const createJobMock = vi.fn();
  const markDoneMock = vi.fn();
  const updateJobMock = vi.fn();
  const findActiveReleaseJobMock = vi.fn();
  const getJobMock = vi.fn();
  const resolveProjectPathMock = vi.fn();
  const appendFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  const unlinkSyncMock = vi.fn();
  const readParsedLogMock = vi.fn();
  const startJobMock = vi.fn();
  const getJobStatusMock = vi.fn();
  const deleteJobMock = vi.fn();
  const ensureBranchForCtxMock = vi.fn();
  const checkCliStartGateMock = vi.fn();
  // Finished `mark-dod-verify` job rows, keyed by id. The startJobInProcess mock
  // populates this (with the exit code from getJobStatusMock); waitForJobCompletion
  // and getJob read from it so readMarkDodVerificationResult sees a finished job.
  const verifyStore = new Map<string, { id: string; logPath: string; exitCode: number; finishedAt: number }>();
  return {
    execMock, listJobsMock, createJobMock, markDoneMock, updateJobMock,
    findActiveReleaseJobMock, getJobMock, resolveProjectPathMock,
    appendFileSyncMock, existsSyncMock, mkdirSyncMock, readFileSyncMock,
    writeFileSyncMock, unlinkSyncMock, readParsedLogMock, startJobMock,
    getJobStatusMock, deleteJobMock, ensureBranchForCtxMock, checkCliStartGateMock,
    verifyStore,
  };
});

vi.mock('@/lib/shared/project-data', () => ({ resolveProjectPath: mocks.resolveProjectPathMock }));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: () => ({ claudeBin: 'claude', logDir: '/tmp/tamtam-logs', projects: {} }),
}));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: mocks.checkCliStartGateMock,
}));
vi.mock('@/lib/shared/config', () => ({
  getPermissionModeFlag: () => '--permission-mode bypassPermissions',
  getPipelineModel: () => 'haiku',
  getSettings: () => ({ cli_enabled_providers: ['claude'] }),
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: mocks.createJobMock,
  listJobs: mocks.listJobsMock,
  markDone: mocks.markDoneMock,
  updateJob: mocks.updateJobMock,
  findActiveReleaseJob: mocks.findActiveReleaseJobMock,
  getJob: mocks.getJobMock,
  readParsedLog: mocks.readParsedLogMock,
}));
vi.mock('@/lib/jobs/storage', () => ({
  listJobs: mocks.listJobsMock,
  findActiveReleaseJob: mocks.findActiveReleaseJobMock,
  getJob: mocks.getJobMock,
}));
// Default branch-switch to a no-op so the tests' explicit exec mock chain
// isn't consumed by the gh pr lookup. Tests that exercise the branch-switch
// behavior can re-mock this via the exposed mock fn.
vi.mock('@/lib/pipeline/mark-dod-branch', () => ({
  ensureBranchForCtx: mocks.ensureBranchForCtxMock,
}));
// start-mark-dod now spawns the verify Claude via the shared supervised-job
// path (startJobInProcess) and waits for it (waitForJobCompletion), rather than
// the old inline runSubprocess. The mock records a finished verify job (exit
// code from getJobStatusMock) into verifyStore and preserves the startJob call
// shape (jobId, command, prompt, cwd) so existing assertions keep working.
vi.mock('@/lib/jobs/spawn-claude-detached', () => ({
  startJobInProcess: vi.fn().mockImplementation(
    async (jobId: string, command: string, prompt: string, cwd: string) => {
      const status = await mocks.getJobStatusMock();
      await mocks.startJobMock(jobId, command, prompt, cwd);
      mocks.verifyStore.set(jobId, { id: jobId, logPath: `/tmp/tamtam-logs/${jobId}.log`, exitCode: status?.exitCode ?? 0, finishedAt: 1 });
      return 12345;
    },
  ),
}));
vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: vi.fn().mockImplementation(async (jobId: string) => ({
    job: mocks.verifyStore.get(jobId) ?? null,
    finished: true,
    reason: 'finished',
  })),
}));
vi.mock('fs', () => ({
  appendFileSync: mocks.appendFileSyncMock,
  existsSync: mocks.existsSyncMock,
  mkdirSync: mocks.mkdirSyncMock,
  readFileSync: mocks.readFileSyncMock,
  writeFileSync: mocks.writeFileSyncMock,
  unlinkSync: mocks.unlinkSyncMock,
}));
// Stub out the file-config loader so wrapIfUntrusted does not shell out to
// `git` (via getBranchContext → execFileSync) for every external author —
// each real git invocation against a non-existent project path costs
// ~10ms, and the tests call wrapIfUntrusted twice per claude-path test.
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
  loadFileConfigWithSource: () => ({
    config: null,
    source: {
      kind: 'pinned-ref',
      ref: 'test',
      relPath: '.tamtam/config.yml',
      fingerprint: 'null',
    },
  }),
  fingerprintWorkingTreeConfig: () => 'test',
}));

// Import once at module scope; mocks above are hoisted before this resolves.
import { startMarkDod } from '@/lib/pipeline/start-mark-dod';

describe('startMarkDod', () => {
  const {
    execMock, listJobsMock, createJobMock, markDoneMock, updateJobMock,
    findActiveReleaseJobMock, getJobMock, resolveProjectPathMock,
    appendFileSyncMock, existsSyncMock, mkdirSyncMock, readFileSyncMock,
    writeFileSyncMock, unlinkSyncMock, readParsedLogMock, startJobMock,
    getJobStatusMock, deleteJobMock, ensureBranchForCtxMock, checkCliStartGateMock,
  } = mocks;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  function makeRunJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-job-1',
      project: 'myproj',
      kind: 'run',
      startedAt: Date.now() / 1000,
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ...overrides,
    };
  }

  beforeEach(() => {
    // Reset call history + implementations for every mock so each test starts
    // from the same baseline, then re-install per-test defaults.
    execMock.mockReset();
    listJobsMock.mockReset();
    createJobMock.mockReset();
    markDoneMock.mockReset();
    updateJobMock.mockReset();
    findActiveReleaseJobMock.mockReset();
    getJobMock.mockReset();
    resolveProjectPathMock.mockReset();
    appendFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    readParsedLogMock.mockReset();
    startJobMock.mockReset();
    getJobStatusMock.mockReset();
    deleteJobMock.mockReset();
    ensureBranchForCtxMock.mockReset();
    checkCliStartGateMock.mockReset();

    listJobsMock.mockReturnValue([makeRunJob()]);
    createJobMock.mockImplementation((project: string, kind: string, pid: number) => ({
      id: `${kind}-job-id`,
      project,
      kind,
      pid,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    }));
    markDoneMock.mockResolvedValue(undefined);
    findActiveReleaseJobMock.mockReturnValue(null);
    mocks.verifyStore.clear();
    // getJob resolves the finished verify job from the store (for the read
    // step); unknown ids return null as before.
    getJobMock.mockImplementation((id: string) => mocks.verifyStore.get(id) ?? null);
    resolveProjectPathMock.mockReturnValue('/path/to/proj');
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      results: [
        { index: 1, text: 'First criterion', verified: true, evidence: 'found in lib/auth.ts' },
        { index: 2, text: 'Second criterion', verified: false, evidence: 'not found' },
      ],
    }));
    readParsedLogMock.mockReturnValue('');
    startJobMock.mockResolvedValue(12345);
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 0 });
    deleteJobMock.mockResolvedValue(undefined);
    ensureBranchForCtxMock.mockResolvedValue({ switched: false, skipped: 'mocked in tests' });
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'claude' });
  });

  const ISSUE_JSON = JSON.stringify({
    title: 'Add login feature',
    body: '- [ ] First criterion\n- [ ] Second criterion',
    author: { login: 'external-user' },
  });

  const CLAUDE_JSON = JSON.stringify({
    results: [
      { index: 1, text: 'First criterion', verified: true, evidence: 'found in lib/auth.ts' },
      { index: 2, text: 'Second criterion', verified: false, evidence: 'not found' },
    ],
  });

  it('returns 404 when project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await startMarkDod('unknown');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('not found');
    }
  });

  it('returns 400 when no issue-linked run job exists', async () => {
    listJobsMock.mockReturnValue([]);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('no issue or PR context');
    }
  });

  it('returns 400 when latest run job has no ghIssueNumber', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueNumber: null })]);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when latest run job has no ghIssueRepo', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueRepo: null })]);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('recovers a missing latest-run ghIssueRepo from an older row for the same issue', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ id: 'older-run', startedAt: 1000, ghIssueRepo: 'owner/repo' }),
      makeRunJob({ id: 'latest-run', startedAt: 2000, ghIssueRepo: null, ghIssueTitle: 'Recovered repo' }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('42');
    expect(ghArgs).toContain('owner/repo');
  });

  it('stamps issue context onto the mark-dod job row', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ISSUE_JSON))
      .mockImplementationOnce(() => resp(0, ''));
    readFileSyncMock.mockReturnValue(CLAUDE_JSON);

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const job = createJobMock.mock.results[0]?.value;
    expect(job.ghIssueNumber).toBe(42);
    expect(job.ghIssueRepo).toBe('owner/repo');
    expect(job.ghIssueTitle).toBe('Add login feature');
    expect(job.contextMeta).toContain('"sourceType":"issue"');
    expect(job.contextMeta).toContain('"sourceNumber":42');
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mark-dod',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Add login feature',
    }));
  });

  it('returns ok:true changed:false when gh issue view fails', async () => {
    execMock.mockResolvedValue(resp(1, '', 'not found'));
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when issue body has no unchecked criteria', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: 'No checkboxes here' })));
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('returns ok:true changed:false when all criteria are already checked', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: '- [x] Already done' })));
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude exits non-zero', async () => {
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));  // gh issue view
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 1 });
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(2);
      expect(r.verified).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when claude returns empty output', async () => {
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));
    readFileSyncMock.mockReturnValue('');
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude returns invalid JSON', async () => {
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));
    readFileSyncMock.mockReturnValue('not json at all');
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(2);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when no criteria are verified', async () => {
    const noneVerified = JSON.stringify({
      results: [
        { index: 1, text: 'First criterion', verified: false, evidence: 'not found' },
        { index: 2, text: 'Second criterion', verified: false, evidence: 'not found' },
      ],
    });
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));
    readFileSyncMock.mockReturnValue(noneVerified);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
      expect(r.total).toBe(2);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it("returns ok:true changed:false when verified results match neither index nor (fuzzy) text", async () => {
    // Out-of-range index AND non-matching text → falls through both lookup
    // paths → no checkbox identified → no edit pushed.
    const mismatch = JSON.stringify({
      results: [
        { index: 99, text: 'Completely unrelated text', verified: true, evidence: 'found' },
      ],
    });
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));
    readFileSyncMock.mockReturnValue(mismatch);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('matches a verified criterion via index even when claude strips markdown decoration from text', async () => {
    // Claude often returns the criterion text without backticks/asterisks
    // even though the prompt embeds them. The `index` field is authoritative.
    const stripped = JSON.stringify({
      results: [
        { index: 1, text: 'first criterion sans markdown', verified: true, evidence: 'found' },
      ],
    });
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))  // gh issue view
      .mockResolvedValueOnce(resp(0, ''));          // gh issue edit
    readFileSyncMock.mockReturnValue(stripped);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(true);
      expect(r.verified).toBe(1);
    }
  });

  it('returns ok:true changed:false when gh issue edit fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))         // gh issue view
      .mockResolvedValueOnce(resp(1, '', 'edit failed')); // gh issue edit
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(1);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('happy path: returns ok:true changed:true when criteria are verified and issue is updated', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))  // gh issue view
      .mockResolvedValueOnce(resp(0, ''));          // gh issue edit
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(true);
      expect(r.verified).toBe(1);
      expect(r.total).toBe(2);
      expect(r.issueNumber).toBe(42);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('reads claude output without a separate existence precheck', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    existsSyncMock.mockReturnValue(false);

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(true);
      expect(r.verified).toBe(1);
    }
    expect(readFileSyncMock).toHaveBeenCalledWith('/tmp/tamtam-logs/mark-dod-verify-job-id.log', 'utf-8');
  });

  it('happy path: writes updated body to temp file for gh issue edit', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    // Two writes now: (1) the Claude prompt file, (2) the gh issue edit body.
    // The edit body contains rendered checkboxes; the prompt does not.
    const ghEditWrite = writeFileSyncMock.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('[x] First criterion'),
    );
    expect(ghEditWrite).toBeDefined();
    const writtenContent: string = ghEditWrite![1];
    expect(writtenContent).toContain('[x] First criterion');
    expect(writtenContent).toContain('[ ] Second criterion');
  });

  it('cleans up temp file even when gh issue edit fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(1, '', 'edit failed'));
    await startMarkDod('myproj', undefined);
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it('cleans up temp file on successful edit', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it('uses the most recent run job with a ghIssueNumber when multiple exist', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ id: 'old-job', ghIssueNumber: 10, startedAt: 1000 }),
      makeRunJob({ id: 'new-job', ghIssueNumber: 42, startedAt: 9999 }),
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issueNumber).toBe(42);
    // gh issue view should use issue 42
    const ghCall = execMock.mock.calls[0];
    expect(ghCall[1]).toContain('42');
  });

  it('creates a mark-dod job and logs start', async () => {
    execMock.mockResolvedValue(resp(1, '', 'fail'));  // gh view fails → early return
    await startMarkDod('myproj', undefined);
    expect(createJobMock).toHaveBeenCalledWith('myproj', 'mark-dod', 0, '');
    expect(appendFileSyncMock).toHaveBeenCalled();
    const firstLog: string = appendFileSyncMock.mock.calls[0][1];
    expect(firstLog).toContain('mark-dod start');
    expect(firstLog).toContain('owner/repo#42');
  });

  it('extracts JSON from code-fenced claude output', async () => {
    const fenced = '```json\n' + CLAUDE_JSON + '\n```';
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    readFileSyncMock.mockReturnValue(fenced);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('extracts JSON when claude output has leading prose before the object', async () => {
    const withProse = 'Here are the results:\n' + CLAUDE_JSON;
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    readFileSyncMock.mockReturnValue(withProse);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('passes --model haiku and cwd to claude invocation', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    // startJob(jobId, command, prompt, cwd)
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, command, , cwd] = startJobMock.mock.calls[0];
    expect(command).toContain('--model');
    expect(command).toContain('haiku');
    expect(cwd).toBe('/path/to/proj');
  });

  it('passes --allowed-tools Read,Grep,Glob to restrict DoD to read-only tools', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    const [, command] = startJobMock.mock.calls[0];
    expect(command).toContain('--allowed-tools');
    expect(command).toContain('Read');
    expect(command).toContain('Grep');
    expect(command).toContain('Glob');
    expect(command).not.toContain('Bash');
  });

  it('wraps issue title and criteria in untrusted tags for external authors', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('<untrusted');
    expect(prompt).toContain('Add login feature');
    expect(prompt).toContain('First criterion');
  });

  it('prepends untrusted system instruction to the DoD prompt', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined);
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('SECURITY:');
    expect(prompt.indexOf('SECURITY:')).toBeLessThan(prompt.indexOf('Add login feature'));
  });

  it('fetches author field in gh view call', async () => {
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj', undefined);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs.join(' ')).toContain('author');
  });

  it('returns ok:false status:500 when an unexpected exception is thrown', async () => {
    execMock.mockRejectedValue(new Error('network error'));
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('network error');
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('uses issue number and repo from the matching job in gh commands', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueNumber: 99, ghIssueRepo: 'acme/widget' })]);
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj', undefined);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('99');
    expect(ghArgs).toContain('acme/widget');
  });

  // ── PR context (findPrContext fallback) ──────────────────────────────────────

  function makePushJob(contextMeta: string | null, overrides: Record<string, unknown> = {}) {
    return {
      id: 'push-job-1',
      project: 'myproj',
      kind: 'push',
      startedAt: Date.now() / 1000,
      contextMeta,
      ...overrides,
    };
  }

  function makeReleaseJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'release-job-1',
      project: 'myproj',
      kind: 'release',
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      releaseId: 'release-job-1',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Fix login bug',
      ...overrides,
    };
  }

  it('uses PR context when no issue-linked run job exists but a push job has prNumber+prRepo in contextMeta', async () => {
    listJobsMock.mockReturnValue([
      makePushJob(JSON.stringify({ prNumber: 99, prRepo: 'owner/repo' })),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));
    const r = await startMarkDod('myproj', undefined);
    // Should attempt gh pr view, not gh issue view
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('pr');
    expect(ghArgs).toContain('view');
    expect(ghArgs).toContain('99');
    expect(r.ok).toBe(true); // non-fatal early exit on gh failure
  });

  it('returns 400 when push job contextMeta has no prNumber', async () => {
    listJobsMock.mockReturnValue([
      makePushJob(JSON.stringify({ prRepo: 'owner/repo' })),
    ]);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when push job contextMeta is malformed JSON', async () => {
    listJobsMock.mockReturnValue([
      makePushJob('not-valid-json'),
    ]);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('prefers issue context over PR context when both exist', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ ghIssueNumber: 42, ghIssueRepo: 'owner/repo' }),
      makePushJob(JSON.stringify({ prNumber: 99, prRepo: 'owner/repo' }), { startedAt: Date.now() / 1000 + 10 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj', undefined);
    // Should use gh issue view (not gh pr view)
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('42');
  });

  it('uses the active release issue lineage instead of a newer unrelated run', async () => {
    const activeRelease = makeReleaseJob({ id: 'release-42', ghIssueNumber: 42, ghIssueRepo: 'owner/repo' });
    findActiveReleaseJobMock.mockReturnValue(activeRelease);
    listJobsMock.mockReturnValue([
      activeRelease,
      makeRunJob({ id: 'issue-42-run', ghIssueNumber: 42, ghIssueRepo: 'owner/repo', releaseId: 'release-42', startedAt: 1000 }),
      makeRunJob({ id: 'newer-issue-99-run', ghIssueNumber: 99, ghIssueRepo: 'owner/repo', startedAt: 9999 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('42');
    expect(ghArgs).not.toContain('99');
  });

  it('uses the newest unfinished release when duplicate active releases exist', async () => {
    const olderRelease = makeReleaseJob({
      id: 'release-42',
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      startedAt: 1000,
    });
    const newerRelease = makeReleaseJob({
      id: 'release-77',
      ghIssueNumber: 77,
      ghIssueRepo: 'owner/repo',
      startedAt: 2000,
    });
    listJobsMock.mockReturnValue([
      olderRelease,
      newerRelease,
      makeRunJob({ id: 'issue-42-run', ghIssueNumber: 42, ghIssueRepo: 'owner/repo', releaseId: 'release-42', startedAt: 1100 }),
      makeRunJob({ id: 'issue-77-run', ghIssueNumber: 77, ghIssueRepo: 'owner/repo', releaseId: 'release-77', startedAt: 2100 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('77');
    expect(ghArgs).not.toContain('42');
  });

  it('recovers a missing release-scoped ghIssueRepo from a sibling row in the same release', async () => {
    const activeRelease = makeReleaseJob({ id: 'release-42', ghIssueNumber: 42, ghIssueRepo: null });
    findActiveReleaseJobMock.mockReturnValue(activeRelease);
    listJobsMock.mockReturnValue([
      activeRelease,
      makeRunJob({ id: 'issue-42-source', ghIssueRepo: null, releaseId: 'release-42', startedAt: 1000 }),
      makeRunJob({ id: 'issue-42-sibling', ghIssueRepo: 'owner/repo', releaseId: 'release-42', startedAt: 900 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('42');
    expect(ghArgs).toContain('owner/repo');
  });

  it('uses the active release push lineage instead of a newer unrelated run when verifying a PR', async () => {
    const activeRelease = makeReleaseJob({
      id: 'release-pr',
      ghIssueNumber: null,
      ghIssueRepo: null,
      ghIssueTitle: null,
    });
    findActiveReleaseJobMock.mockReturnValue(activeRelease);
    listJobsMock.mockReturnValue([
      activeRelease,
      makePushJob(JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' }), {
        id: 'push-pr-55',
        releaseId: 'release-pr',
        startedAt: 1000,
      }),
      makeRunJob({ id: 'newer-issue-99-run', ghIssueNumber: 99, ghIssueRepo: 'owner/repo', startedAt: 9999 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('pr');
    expect(ghArgs).toContain('55');
    expect(ghArgs).not.toContain('99');
  });

  it('PR context happy path: uses gh pr view and gh pr edit to update the PR body', async () => {
    listJobsMock.mockReturnValue([
      makePushJob(JSON.stringify({ prNumber: 55, prRepo: 'owner/repo' })),
    ]);
    const prJson = JSON.stringify({ title: 'My PR', body: '- [ ] Implement feature\n- [ ] Add tests' });
    const claudeJson = JSON.stringify({
      results: [
        { index: 1, text: 'Implement feature', verified: true, evidence: 'lib/feature.ts' },
        { index: 2, text: 'Add tests', verified: false, evidence: 'not found' },
      ],
    });
    execMock
      .mockResolvedValueOnce(resp(0, prJson))  // gh pr view
      .mockResolvedValueOnce(resp(0, ''));     // gh pr edit
    readFileSyncMock.mockReturnValue(claudeJson);
    const r = await startMarkDod('myproj', undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(true);
      expect(r.verified).toBe(1);
      expect(r.issueNumber).toBe(55);
    }
    const editCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'gh' && args.includes('pr') && args.includes('edit'));
    expect(editCall).toBeTruthy();
    const viewCall = execMock.mock.calls[0];
    expect(viewCall[1]).toContain('pr');
    expect(viewCall[1]).toContain('view');
  });

  // ─── Pipeline mode ────────────────────────────────────────────────────────────

  it('always spawns Claude to verify criteria — never reads the review log', async () => {
    const activeRelease = { id: 'release-3', kind: 'release', project: 'myproj', startedAt: 100 };
    const reviewJob = {
      id: 'review-3', kind: 'review', project: 'myproj',
      releaseId: 'release-3', finishedAt: 200, startedAt: 150,
    };
    findActiveReleaseJobMock.mockReturnValue(activeRelease);
    listJobsMock.mockReturnValue([
      activeRelease,
      reviewJob,
      makeRunJob({ releaseId: 'release-3' }),
    ]);
    readParsedLogMock.mockReturnValue('## Verified criteria\n- [x] Add unit tests\n');
    const issueJson = JSON.stringify({
      body: '- [ ] Add unit tests',
      title: 'Feature', author: { login: 'owner' },
    });
    execMock.mockResolvedValueOnce(resp(0, issueJson));
    startJobMock.mockResolvedValue(12345);
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 1 });

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    expect(startJobMock).toHaveBeenCalled();
  });

  it('creates a supervised mark-dod-verify job parented to the mark-dod job', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));

    const r = await startMarkDod('myproj', undefined);

    expect(r.ok).toBe(true);
    const verifyCreate = createJobMock.mock.calls.find((c: unknown[]) => c[1] === 'mark-dod-verify');
    expect(verifyCreate).toBeTruthy();
    // parentJobId is positional arg #11 (index 10) — the mark-dod phase job.
    expect(verifyCreate?.[10]).toBe('mark-dod-job-id');
    // Spawned via the shared supervised-job path, not an inline subprocess.
    const startCall = startJobMock.mock.calls.find((c: unknown[]) => c[0] === 'mark-dod-verify-job-id');
    expect(startCall).toBeTruthy();
  });
});
