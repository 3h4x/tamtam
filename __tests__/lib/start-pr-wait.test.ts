import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 1ms poll (not 0 — parseInt('0') || 30_000 = 30_000 since 0 is falsy)
process.env.TAMTAM_PR_WAIT_POLL_MS = '1';
process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '5000';

describe('launchPrWait', () => {
  let launchPrWait: typeof import('@/lib/start-pr-wait').launchPrWait;
  let execMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startMarkDodMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    execMock = vi.fn();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-test`, project, kind, pid, logPath,
      prompt: null, startedAt: Date.now() / 1000, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheCreateTokens: null, sessionId: null, contextMeta: null, userPrompt: null,
    }));
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();
    startMarkDodMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'dod-1', issueNumber: 42, verified: 2, total: 2, changed: true });

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/start-mark-dod', () => ({
      startMarkDod: startMarkDodMock,
    }));

    ({ launchPrWait } = await import('@/lib/start-pr-wait'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  // Mock a successful post-merge branch switch (symbolic-ref + show-current + status + checkout + pull)
  function mockCleanupSuccess() {
    execMock
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockResolvedValueOnce(resp(0, 'fix/issue-5\n')) // branch --show-current
      .mockResolvedValueOnce(resp(0, '')) // status --porcelain (clean)
      .mockResolvedValueOnce(resp(0, '')) // checkout main
      .mockResolvedValueOnce(resp(0, '')); // pull --ff-only
  }

  it('returns error when project not found', async () => {
    vi.resetModules();
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }) }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    const { launchPrWait: launchPrWait2 } = await import('@/lib/start-pr-wait');
    const r = launchPrWait2('missing-proj', 1, 'owner/repo', 'https://github.com/owner/repo/pull/1');
    expect(r).toEqual({ error: 'project not found' });
  });

  it('returns jobId immediately (fire-and-forget)', () => {
    const r = launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');
    expect(r).toHaveProperty('jobId');
  });

  it('creates a pr-wait job with kind pr-wait', () => {
    launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');
    expect(createJobMock).toHaveBeenCalledWith('myproj', 'pr-wait', expect.any(Number), '');
  });

  it('marks job done with exit 0 when PR is already merged', async () => {
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({
      state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [],
    })));
    mockCleanupSuccess();

    launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('marks job done with exit 1 when PR is closed without merging', async () => {
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({
      state: 'CLOSED', mergeable: 'NOT_MERGEABLE', statusCheckRollup: [],
    })));

    launchPrWait('myproj', 7, 'owner/repo', 'https://github.com/owner/repo/pull/7');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('marks job done with exit 1 when required checks fail', async () => {
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [
        { name: 'ci/test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    })));

    launchPrWait('myproj', 5, 'owner/repo', 'https://github.com/owner/repo/pull/5');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('merges when all checks pass and marks job done 0', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      })))
      .mockResolvedValueOnce(resp(0, 'PR merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 5, 'owner/repo', 'https://github.com/owner/repo/pull/5');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('marks job done with exit 1 when merge fails permanently', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(1, '', 'merge failed: insufficient permissions'));

    launchPrWait('myproj', 3, 'owner/repo', 'https://github.com/owner/repo/pull/3');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('marks job done with exit 1 when PR has merge conflicts', async () => {
    execMock.mockResolvedValueOnce(resp(0, JSON.stringify({
      state: 'OPEN',
      mergeable: 'CONFLICTING',
      statusCheckRollup: [],
    })));

    launchPrWait('myproj', 9, 'owner/repo', 'https://github.com/owner/repo/pull/9');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('falls back to --auto when direct merge blocked by pending checks', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(1, '', 'required status checks have not passed'))
      .mockResolvedValueOnce(resp(0, 'Auto-merge enabled'));
    mockCleanupSuccess();

    launchPrWait('myproj', 11, 'owner/repo', 'https://github.com/owner/repo/pull/11');

    await vi.waitFor(() => {
      const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
      expect(autoCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('calls mark-dod after successful merge', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 13, 'owner/repo', 'https://github.com/owner/repo/pull/13');

    await vi.waitFor(() => {
      expect(startMarkDodMock).toHaveBeenCalledWith('myproj');
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('marks done 0 even when mark-dod throws', async () => {
    startMarkDodMock.mockRejectedValueOnce(new Error('dod boom'));
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 14, 'owner/repo', 'https://github.com/owner/repo/pull/14');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('marks done 1 when switchToDefault fails after merge', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref, show-current, status, checkout fails
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-9\n'))
      .mockResolvedValueOnce(resp(0, ''))
      .mockResolvedValueOnce(resp(1, '', 'checkout failed'));

    launchPrWait('myproj', 15, 'owner/repo', 'https://github.com/owner/repo/pull/15');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('skips checkout when already on main branch and just pulls', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref returns main, show-current returns main → just pull
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'main\n'))
      .mockResolvedValueOnce(resp(0, ''));  // pull --ff-only

    launchPrWait('myproj', 16, 'owner/repo', 'https://github.com/owner/repo/pull/16');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
      // no checkout call should have been made
      const checkoutCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('checkout'));
      expect(checkoutCalls.length).toBe(0);
    }, { timeout: 3000 });
  });

  it('stashes dirty working tree before switching branch', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref, show-current (on feature branch), status (dirty), stash, checkout, pull, stash pop
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-10\n'))
      .mockResolvedValueOnce(resp(0, 'M  src/foo.ts\n'))  // dirty
      .mockResolvedValueOnce(resp(0, 'Saved working directory'))  // stash push
      .mockResolvedValueOnce(resp(0, ''))  // checkout main
      .mockResolvedValueOnce(resp(0, ''))  // pull --ff-only
      .mockResolvedValueOnce(resp(0, ''));  // stash pop

    launchPrWait('myproj', 17, 'owner/repo', 'https://github.com/owner/repo/pull/17');

    await vi.waitFor(() => {
      const stashPushCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('stash') && args.includes('push'));
      expect(stashPushCalls.length).toBe(1);
      const stashPopCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('stash') && args.includes('pop'));
      expect(stashPopCalls.length).toBe(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('retries when PR status fetch fails then succeeds on next poll', async () => {
    execMock
      // First poll: gh pr view fails (network error) → null status → retry
      .mockResolvedValueOnce(resp(1, '', 'network error'))
      // Second poll: PR already merged
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })));
    mockCleanupSuccess();

    launchPrWait('myproj', 99, 'owner/repo', 'https://github.com/owner/repo/pull/99');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('retries transiently-failed --auto merge on next poll and succeeds', async () => {
    execMock
      // Poll 1: open, checks pass
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(1, '', 'required status checks have not passed'))  // direct merge blocked
      .mockResolvedValueOnce(resp(1, '', 'auto-merge transient error'))  // --auto also fails (transient)
      // Poll 2: open, checks pass, merge succeeds
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'PR merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 20, 'owner/repo', 'https://github.com/owner/repo/pull/20');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });
});
