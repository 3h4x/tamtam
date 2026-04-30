import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractCriteria, tickCriteria } from '@/lib/pipeline/start-mark-dod';

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

describe('startMarkDod', () => {
  let startMarkDod: typeof import('@/lib/pipeline/start-mark-dod').startMarkDod;
  let execMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let appendFileSyncMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let mkdirSyncMock: ReturnType<typeof vi.fn>;
  let readFileSyncMock: ReturnType<typeof vi.fn>;
  let writeFileSyncMock: ReturnType<typeof vi.fn>;
  let unlinkSyncMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let getJobStatusMock: ReturnType<typeof vi.fn>;
  let deleteJobMock: ReturnType<typeof vi.fn>;

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

  beforeEach(async () => {
    vi.resetModules();

    execMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([makeRunJob()]);
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number) => ({
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
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    appendFileSyncMock = vi.fn();
    existsSyncMock = vi.fn().mockReturnValue(true);
    mkdirSyncMock = vi.fn();
    readFileSyncMock = vi.fn().mockReturnValue(JSON.stringify({
      results: [
        { index: 1, text: 'First criterion', verified: true, evidence: 'found in lib/auth.ts' },
        { index: 2, text: 'Second criterion', verified: false, evidence: 'not found' },
      ],
    }));
    writeFileSyncMock = vi.fn();
    unlinkSyncMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(12345);
    getJobStatusMock = vi.fn().mockResolvedValue({ status: 'done', exitCode: 0 });
    deleteJobMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', logDir: '/tmp/tamtam-logs', projects: {} }),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getPipelineModel: () => 'haiku',
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      listJobs: listJobsMock,
      markDone: markDoneMock,
      updateJob: vi.fn(),
    }));
    // Default branch-switch to a no-op so the tests' explicit exec mock
    // chain isn't consumed by the gh pr lookup. Tests that exercise the
    // branch-switch behavior re-mock this module directly.
    vi.doMock('@/lib/pipeline/mark-dod-branch', () => ({
      ensureBranchForCtx: vi.fn().mockResolvedValue({ switched: false, skipped: 'mocked in tests' }),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
      getJobStatus: getJobStatusMock,
      deleteJob: deleteJobMock,
    }));
    vi.doMock('fs', () => ({
      appendFileSync: appendFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      readFileSync: readFileSyncMock,
      writeFileSync: writeFileSyncMock,
      unlinkSync: unlinkSyncMock,
    }));

    ({ startMarkDod } = await import('@/lib/pipeline/start-mark-dod'));
  });

  afterEach(() => { vi.resetModules(); });

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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('no issue or PR context');
    }
  });

  it('returns 400 when latest run job has no ghIssueNumber', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueNumber: null })]);
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when latest run job has no ghIssueRepo', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueRepo: null })]);
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns ok:true changed:false when gh issue view fails', async () => {
    execMock.mockResolvedValue(resp(1, '', 'not found'));
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when issue body has no unchecked criteria', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: 'No checkboxes here' })));
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('returns ok:true changed:false when all criteria are already checked', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: '- [x] Already done' })));
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude exits non-zero', async () => {
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));  // gh issue view
    getJobStatusMock.mockResolvedValue({ status: 'done', exitCode: 1 });
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude returns invalid JSON', async () => {
    execMock.mockResolvedValueOnce(resp(0, ISSUE_JSON));
    readFileSyncMock.mockReturnValue('not json at all');
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(true);
      expect(r.verified).toBe(1);
      expect(r.total).toBe(2);
      expect(r.issueNumber).toBe(42);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('happy path: writes updated body to temp file for gh issue edit', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined, 0);
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
    const writtenContent: string = writeFileSyncMock.mock.calls[0][1];
    expect(writtenContent).toContain('[x] First criterion');
    expect(writtenContent).toContain('[ ] Second criterion');
  });

  it('cleans up temp file even when gh issue edit fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(1, '', 'edit failed'));
    await startMarkDod('myproj', undefined, 0);
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it('cleans up temp file on successful edit', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issueNumber).toBe(42);
    // gh issue view should use issue 42
    const ghCall = execMock.mock.calls[0];
    expect(ghCall[1]).toContain('42');
  });

  it('creates a mark-dod job and logs start', async () => {
    execMock.mockResolvedValue(resp(1, '', 'fail'));  // gh view fails → early return
    await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('extracts JSON when claude output has leading prose before the object', async () => {
    const withProse = 'Here are the results:\n' + CLAUDE_JSON;
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    readFileSyncMock.mockReturnValue(withProse);
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('passes --model haiku and cwd to claude invocation', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined, 0);
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
    await startMarkDod('myproj', undefined, 0);
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
    await startMarkDod('myproj', undefined, 0);
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('<untrusted');
    expect(prompt).toContain('Add login feature');
    expect(prompt).toContain('First criterion');
  });

  it('prepends untrusted system instruction to the DoD prompt', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj', undefined, 0);
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('SECURITY:');
    expect(prompt.indexOf('SECURITY:')).toBeLessThan(prompt.indexOf('Add login feature'));
  });

  it('fetches author field in gh view call', async () => {
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj', undefined, 0);
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs.join(' ')).toContain('author');
  });

  it('returns ok:false status:500 when an unexpected exception is thrown', async () => {
    execMock.mockRejectedValue(new Error('network error'));
    const r = await startMarkDod('myproj', undefined, 0);
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
    await startMarkDod('myproj', undefined, 0);
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

  it('uses PR context when no issue-linked run job exists but a push job has prNumber+prRepo in contextMeta', async () => {
    listJobsMock.mockReturnValue([
      makePushJob(JSON.stringify({ prNumber: 99, prRepo: 'owner/repo' })),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'gh failed'));
    const r = await startMarkDod('myproj', undefined, 0);
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
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when push job contextMeta is malformed JSON', async () => {
    listJobsMock.mockReturnValue([
      makePushJob('not-valid-json'),
    ]);
    const r = await startMarkDod('myproj', undefined, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('prefers issue context over PR context when both exist', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ ghIssueNumber: 42, ghIssueRepo: 'owner/repo' }),
      makePushJob(JSON.stringify({ prNumber: 99, prRepo: 'owner/repo' }), { startedAt: Date.now() / 1000 + 10 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj', undefined, 0);
    // Should use gh issue view (not gh pr view)
    const ghArgs: string[] = execMock.mock.calls[0][1];
    expect(ghArgs).toContain('issue');
    expect(ghArgs).toContain('42');
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
    const r = await startMarkDod('myproj', undefined, 0);
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
});
