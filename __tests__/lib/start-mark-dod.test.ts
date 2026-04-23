import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractCriteria, tickCriteria } from '@/lib/start-mark-dod';

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
  let startMarkDod: typeof import('@/lib/start-mark-dod').startMarkDod;
  let execMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let appendFileSyncMock: ReturnType<typeof vi.fn>;
  let mkdirSyncMock: ReturnType<typeof vi.fn>;
  let writeFileSyncMock: ReturnType<typeof vi.fn>;
  let unlinkSyncMock: ReturnType<typeof vi.fn>;

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
    mkdirSyncMock = vi.fn();
    writeFileSyncMock = vi.fn();
    unlinkSyncMock = vi.fn();

    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', logDir: '/tmp/tamtam-logs', projects: {} }),
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      listJobs: listJobsMock,
      markDone: markDoneMock,
    }));
    vi.doMock('fs', () => ({
      appendFileSync: appendFileSyncMock,
      mkdirSync: mkdirSyncMock,
      writeFileSync: writeFileSyncMock,
      unlinkSync: unlinkSyncMock,
    }));

    ({ startMarkDod } = await import('@/lib/start-mark-dod'));
  });

  afterEach(() => { vi.resetModules(); });

  const ISSUE_JSON = JSON.stringify({
    title: 'Add login feature',
    body: '- [ ] First criterion\n- [ ] Second criterion',
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
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.detail).toContain('no issue or PR context');
    }
  });

  it('returns 400 when latest run job has no ghIssueNumber', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueNumber: null })]);
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when latest run job has no ghIssueRepo', async () => {
    listJobsMock.mockReturnValue([makeRunJob({ ghIssueRepo: null })]);
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns ok:true changed:false when gh issue view fails', async () => {
    execMock.mockResolvedValue(resp(1, '', 'not found'));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when issue body has no unchecked criteria', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: 'No checkboxes here' })));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('returns ok:true changed:false when all criteria are already checked', async () => {
    execMock.mockResolvedValue(resp(0, JSON.stringify({ title: 'T', body: '- [x] Already done' })));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude exits non-zero', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))   // gh issue view
      .mockResolvedValueOnce(resp(1, '', 'claude failed'));  // claude
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.total).toBe(2);
      expect(r.verified).toBe(0);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('returns ok:true changed:false when claude returns empty output', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when claude returns invalid JSON', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, 'not json at all'));
    const r = await startMarkDod('myproj');
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
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, noneVerified));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
      expect(r.total).toBe(2);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it("returns ok:true changed:false when verified texts don't match any checkbox exactly", async () => {
    const mismatch = JSON.stringify({
      results: [
        { index: 1, text: 'Different text entirely', verified: true, evidence: 'found' },
      ],
    });
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, mismatch));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('returns ok:true changed:false when gh issue edit fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))      // gh issue view
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))     // claude verify
      .mockResolvedValueOnce(resp(1, '', 'edit failed')); // gh issue edit
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(1);
    }
    expect(markDoneMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('happy path: returns ok:true changed:true when criteria are verified and issue is updated', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))      // gh issue view
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))     // claude verify
      .mockResolvedValueOnce(resp(0, ''));              // gh issue edit
    const r = await startMarkDod('myproj');
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
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj');
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
    const writtenContent: string = writeFileSyncMock.mock.calls[0][1];
    expect(writtenContent).toContain('[x] First criterion');
    expect(writtenContent).toContain('[ ] Second criterion');
  });

  it('cleans up temp file even when gh issue edit fails', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))
      .mockResolvedValueOnce(resp(1, '', 'edit failed'));
    await startMarkDod('myproj');
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it('cleans up temp file on successful edit', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj');
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it('uses the most recent run job with a ghIssueNumber when multiple exist', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ id: 'old-job', ghIssueNumber: 10, startedAt: 1000 }),
      makeRunJob({ id: 'new-job', ghIssueNumber: 42, startedAt: 9999 }),
    ]);
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issueNumber).toBe(42);
    // gh issue view should use issue 42
    const ghCall = execMock.mock.calls[0];
    expect(ghCall[1]).toContain('42');
  });

  it('creates a mark-dod job and logs start', async () => {
    execMock.mockResolvedValue(resp(1, '', 'fail'));  // gh view fails → early return
    await startMarkDod('myproj');
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
      .mockResolvedValueOnce(resp(0, fenced))
      .mockResolvedValueOnce(resp(0, ''));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('extracts JSON when claude output has leading prose before the object', async () => {
    const withProse = 'Here are the results:\n' + CLAUDE_JSON;
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, withProse))
      .mockResolvedValueOnce(resp(0, ''));
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verified).toBe(1);
  });

  it('passes --model haiku and cwd to claude invocation', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, ISSUE_JSON))
      .mockResolvedValueOnce(resp(0, CLAUDE_JSON))
      .mockResolvedValueOnce(resp(0, ''));
    await startMarkDod('myproj');
    const claudeCall = execMock.mock.calls[1];
    expect(claudeCall[0]).toBe('claude');
    expect(claudeCall[1]).toContain('--model');
    expect(claudeCall[1]).toContain('haiku');
    expect(claudeCall[2].cwd).toBe('/path/to/proj');
  });

  it('returns ok:false status:500 when an unexpected exception is thrown', async () => {
    execMock.mockRejectedValue(new Error('network error'));
    const r = await startMarkDod('myproj');
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
    await startMarkDod('myproj');
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
    const r = await startMarkDod('myproj');
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
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('returns 400 when push job contextMeta is malformed JSON', async () => {
    listJobsMock.mockReturnValue([
      makePushJob('not-valid-json'),
    ]);
    const r = await startMarkDod('myproj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('prefers issue context over PR context when both exist', async () => {
    listJobsMock.mockReturnValue([
      makeRunJob({ ghIssueNumber: 42, ghIssueRepo: 'owner/repo' }),
      makePushJob(JSON.stringify({ prNumber: 99, prRepo: 'owner/repo' }), { startedAt: Date.now() / 1000 + 10 }),
    ]);
    execMock.mockResolvedValue(resp(1, '', 'fail'));
    await startMarkDod('myproj');
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
      .mockResolvedValueOnce(resp(0, prJson))     // gh pr view
      .mockResolvedValueOnce(resp(0, claudeJson)) // claude verify
      .mockResolvedValueOnce(resp(0, ''));        // gh pr edit
    const r = await startMarkDod('myproj');
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
