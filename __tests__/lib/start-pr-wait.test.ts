import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 1ms poll (not 0 — parseInt('0') || 30_000 = 30_000 since 0 is falsy)
process.env.TAMTAM_PR_WAIT_POLL_MS = '1';
process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '5000';
process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS = '0';
// Allow the first empty-rollup poll to merge in tests that don't care about
// CI registration timing. Production default still keeps a 90s grace window.
process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS = '1';

describe('launchPrWait', () => {
  let launchPrWait: typeof import('@/lib/pipeline/start-pr-wait').launchPrWait;
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

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({
      startMarkDod: startMarkDodMock,
    }));

    ({ launchPrWait } = await import('@/lib/pipeline/start-pr-wait'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  // Mock a successful post-merge branch switch (symbolic-ref + show-current + status + checkout + pull + branch -D)
  function mockCleanupSuccess() {
    execMock
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n')) // symbolic-ref
      .mockResolvedValueOnce(resp(0, 'fix/issue-5\n')) // branch --show-current
      .mockResolvedValueOnce(resp(0, '')) // status --porcelain (clean)
      .mockResolvedValueOnce(resp(0, '')) // checkout main
      .mockResolvedValueOnce(resp(0, '')) // pull --ff-only
      .mockResolvedValueOnce(resp(0, '')); // branch -D fix/issue-5
  }

  it('returns error when project not found', async () => {
    vi.resetModules();
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }) }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      markDone: markDoneMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    const { launchPrWait: launchPrWait2 } = await import('@/lib/pipeline/start-pr-wait');
    const r = launchPrWait2('missing-proj', 1, 'owner/repo', 'https://github.com/owner/repo/pull/1');
    expect(r).toEqual({ error: 'project not found' });
  });

  it('returns jobId immediately (fire-and-forget)', () => {
    const r = launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');
    expect(r).toHaveProperty('jobId');
  });

  it('creates a pr-wait job with kind pr-wait', () => {
    launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');
    expect(createJobMock).toHaveBeenCalledWith(
      'myproj',
      'pr-wait',
      expect.any(Number),
      '',
      undefined,
      expect.stringContaining('"prNumber":42'),
    );
  });

  it('persists prNumber/prRepo/prUrl in contextMeta for resumability', () => {
    launchPrWait('myproj', 42, 'owner/myrepo', 'https://github.com/owner/myrepo/pull/42');
    const call = createJobMock.mock.calls[0];
    const meta = JSON.parse(call[5] as string);
    expect(meta).toEqual({
      prNumber: 42,
      prRepo: 'owner/myrepo',
      prUrl: 'https://github.com/owner/myrepo/pull/42',
    });
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

  it('does NOT merge while mergeable is UNKNOWN (waits for GitHub to compute)', async () => {
    // First poll: UNKNOWN — must NOT merge.
    // Second poll: MERGEABLE with passing checks — merges and cleans up.
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN', mergeable: 'UNKNOWN',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      })))
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 100, 'owner/repo', 'https://github.com/owner/repo/pull/100');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBe(1);
    }, { timeout: 3000 });
  });

  it('does NOT merge on the first poll when checks: none (regression: race with CI registration)', async () => {
    // Require 3 consecutive empty-rollup polls before merging.
    vi.resetModules();
    process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS = '3';
    process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS = '0';
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, markDone: markDoneMock, updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
    const { launchPrWait: lpw } = await import('@/lib/pipeline/start-pr-wait');

    // First two polls: empty rollup — must NOT merge yet.
    // Third poll: empty rollup — now allowed to merge.
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'));
    mockCleanupSuccess();

    lpw('myproj', 200, 'owner/repo', 'https://github.com/owner/repo/pull/200');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBe(1);
    }, { timeout: 3000 });

    // Confirm merge happened only after the third status poll, not the first.
    const callsBeforeMerge = execMock.mock.calls;
    const firstMergeIdx = callsBeforeMerge.findIndex(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
    const statusPollsBefore = callsBeforeMerge
      .slice(0, firstMergeIdx)
      .filter(([cmd, args]: any) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'view');
    expect(statusPollsBefore.length).toBeGreaterThanOrEqual(3);

    process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS = '1';
    process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS = '0';
  });

  it('does NOT merge before the default 90s empty-rollup grace elapses', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      delete process.env.TAMTAM_PR_WAIT_POLL_MS;
      process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '200000';
      delete process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS;
      delete process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS;
      vi.doMock('@/lib/shared/project-data', () => ({
        resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
      }));
      vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
      }));
      vi.doMock('@/lib/jobs/job-storage', () => ({
        createJob: createJobMock, markDone: markDoneMock, updateJob: updateJobMock,
      }));
      vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: startMarkDodMock }));
      const { launchPrWait: lpw } = await import('@/lib/pipeline/start-pr-wait');

      execMock
        .mockResolvedValueOnce(resp(0, JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
        })))
        .mockResolvedValueOnce(resp(0, JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
        })))
        .mockResolvedValueOnce(resp(0, JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
        })))
        .mockResolvedValueOnce(resp(0, JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
        })))
        .mockResolvedValueOnce(resp(0, 'merged'));
      mockCleanupSuccess();

      lpw('myproj', 201, 'owner/repo', 'https://github.com/owner/repo/pull/201');

      await vi.advanceTimersByTimeAsync(89_999);
      expect(execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'))).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      process.env.TAMTAM_PR_WAIT_POLL_MS = '1';
      process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '5000';
      process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS = '0';
      process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS = '1';
    }
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
      expect(startMarkDodMock).toHaveBeenCalledWith('myproj', { prNumber: 13, repo: 'owner/repo', mode: 'pipeline' });
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
      // switchToDefault: symbolic-ref, show-current (on feature branch), status (dirty), stash, checkout, pull, stash pop, branch -D
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-10\n'))
      .mockResolvedValueOnce(resp(0, 'M  src/foo.ts\n'))  // dirty
      .mockResolvedValueOnce(resp(0, 'Saved working directory'))  // stash push
      .mockResolvedValueOnce(resp(0, ''))  // checkout main
      .mockResolvedValueOnce(resp(0, ''))  // pull --ff-only
      .mockResolvedValueOnce(resp(0, ''))  // stash pop
      .mockResolvedValueOnce(resp(0, ''));  // branch -D fix/issue-10

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

  it('does not attempt merge when checks are pending, retries on next poll', async () => {
    execMock
      // First poll: checks still in progress
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { name: 'ci/test', status: 'IN_PROGRESS', conclusion: null },
        ],
      })))
      // Second poll: already merged (no merge call should have been made on first poll)
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })));
    mockCleanupSuccess();

    launchPrWait('myproj', 50, 'owner/repo', 'https://github.com/owner/repo/pull/50');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBe(0);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('treats NEUTRAL and SKIPPED conclusions as passing and proceeds to merge', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { name: 'ci/lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { name: 'ci/docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      })))
      .mockResolvedValueOnce(resp(0, 'PR merged'));
    mockCleanupSuccess();

    launchPrWait('myproj', 51, 'owner/repo', 'https://github.com/owner/repo/pull/51');

    await vi.waitFor(() => {
      const mergeCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('merge'));
      expect(mergeCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('"not allowed" in merge error suppresses auto-merge fallback and fails permanently', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      // Matches transient regex but also contains "not allowed" → permanent failure
      .mockResolvedValueOnce(resp(1, '', 'required status checks: not allowed for this context'));

    launchPrWait('myproj', 52, 'owner/repo', 'https://github.com/owner/repo/pull/52');

    await vi.waitFor(() => {
      const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
      expect(autoCalls.length).toBe(0);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('falls back to main when symbolic-ref fails (non-zero exit)', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref fails → mainBranch stays 'main'
      .mockResolvedValueOnce(resp(1, '', 'not a git repo'))  // symbolic-ref fails
      .mockResolvedValueOnce(resp(0, 'fix/issue-20\n'))       // show-current → feature branch
      .mockResolvedValueOnce(resp(0, ''))                     // status --porcelain (clean)
      .mockResolvedValueOnce(resp(0, ''))                     // checkout main
      .mockResolvedValueOnce(resp(0, ''))                     // pull --ff-only
      .mockResolvedValueOnce(resp(0, ''));                    // branch -D fix/issue-20

    launchPrWait('myproj', 60, 'owner/repo', 'https://github.com/owner/repo/pull/60');

    await vi.waitFor(() => {
      const checkoutCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('checkout'));
      expect(checkoutCalls.length).toBe(1);
      expect(checkoutCalls[0][1]).toContain('main');
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('does not call stash pop when stash reports "No local changes"', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref, show-current (feature branch), status (dirty),
      // stash → "No local changes" → stashed=false → no stash pop
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-21\n'))
      .mockResolvedValueOnce(resp(0, 'M  src/bar.ts\n'))                   // dirty
      .mockResolvedValueOnce(resp(0, 'No local changes to save'))           // stash push → nothing stashed
      .mockResolvedValueOnce(resp(0, ''))                                   // checkout main
      .mockResolvedValueOnce(resp(0, ''))                                   // pull --ff-only
      .mockResolvedValueOnce(resp(0, ''));                                  // branch -D fix/issue-21

    launchPrWait('myproj', 61, 'owner/repo', 'https://github.com/owner/repo/pull/61');

    await vi.waitFor(() => {
      const stashPopCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('stash') && args.includes('pop'));
      expect(stashPopCalls.length).toBe(0);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('pops stash after checkout failure when working tree was dirty', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(0, 'merged'))
      // switchToDefault: symbolic-ref, show-current (feature branch), status (dirty),
      // stash succeeds, checkout fails → stash pop to restore
      .mockResolvedValueOnce(resp(0, 'refs/remotes/origin/main\n'))
      .mockResolvedValueOnce(resp(0, 'fix/issue-22\n'))
      .mockResolvedValueOnce(resp(0, 'M  src/baz.ts\n'))               // dirty
      .mockResolvedValueOnce(resp(0, 'Saved working directory'))        // stash push
      .mockResolvedValueOnce(resp(1, '', 'checkout failed'));            // checkout fails → stash pop

    launchPrWait('myproj', 62, 'owner/repo', 'https://github.com/owner/repo/pull/62');

    await vi.waitFor(() => {
      const stashPopCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'git' && args.includes('stash') && args.includes('pop'));
      expect(stashPopCalls.length).toBe(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
    }, { timeout: 3000 });
  });

  it('returns null from getPrStatus when JSON.parse throws, then retries on next poll', async () => {
    execMock
      // First poll: gh pr view exits 0 but returns invalid JSON → parse throws → null → retry
      .mockResolvedValueOnce(resp(0, 'not-json-at-all'))
      // Second poll: PR already merged
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [],
      })));
    mockCleanupSuccess();

    launchPrWait('myproj', 63, 'owner/repo', 'https://github.com/owner/repo/pull/63');

    await vi.waitFor(() => {
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('triggers auto-merge fallback when "mergeable" keyword appears in stderr', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(1, '', 'branch is not mergeable yet'))  // "mergeable" in stderr
      .mockResolvedValueOnce(resp(0, 'Auto-merge enabled'));               // --auto succeeds
    mockCleanupSuccess();

    launchPrWait('myproj', 64, 'owner/repo', 'https://github.com/owner/repo/pull/64');

    await vi.waitFor(() => {
      const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
      expect(autoCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  it('triggers auto-merge fallback when "pending" keyword appears in stderr', async () => {
    execMock
      .mockResolvedValueOnce(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })))
      .mockResolvedValueOnce(resp(1, '', 'merge blocked: pending review'))  // "pending" in stderr
      .mockResolvedValueOnce(resp(0, 'Auto-merge enabled'));                 // --auto succeeds
    mockCleanupSuccess();

    launchPrWait('myproj', 65, 'owner/repo', 'https://github.com/owner/repo/pull/65');

    await vi.waitFor(() => {
      const autoCalls = execMock.mock.calls.filter(([cmd, args]: any) => cmd === 'gh' && args.includes('--auto'));
      expect(autoCalls.length).toBeGreaterThanOrEqual(1);
      expect(markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 0);
    }, { timeout: 3000 });
  });

  describe('timeout', () => {
    let launchPrWaitT: typeof import('@/lib/pipeline/start-pr-wait').launchPrWait;
    let execT: ReturnType<typeof vi.fn>;
    let markDoneT: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '10'; // override to trigger timeout quickly

      execT = vi.fn();
      markDoneT = vi.fn().mockResolvedValue(undefined);

      vi.doMock('@/lib/shared/project-data', () => ({
        resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
      }));
      vi.doMock('@/lib/shared/shell', () => ({ exec: execT }));
      vi.doMock('@/lib/scheduling/scheduling', () => ({
        getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }),
      }));
      vi.doMock('@/lib/jobs/job-storage', () => ({
        createJob: vi.fn().mockImplementation((project: string, kind: string) => ({
          id: `${project}-${kind}-timeout`, project, kind, pid: process.pid, logPath: '',
          prompt: null, startedAt: Date.now() / 1000, finishedAt: null, exitCode: null, seen: false,
        })),
        markDone: markDoneT,
        updateJob: vi.fn(),
      }));
      vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: vi.fn() }));

      ({ launchPrWait: launchPrWaitT } = await import('@/lib/pipeline/start-pr-wait'));
    });

    afterEach(() => {
      vi.resetModules();
      process.env.TAMTAM_PR_WAIT_TIMEOUT_MS = '5000';
    });

    it('marks job done with exit 1 when deadline is exceeded before PR merges', async () => {
      // Always return pending checks so the loop never merges
      execT.mockResolvedValue(resp(0, JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }],
      })));

      launchPrWaitT('myproj', 999, 'owner/repo', 'https://github.com/owner/repo/pull/999');

      await vi.waitFor(() => {
        expect(markDoneT).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr-wait' }), 1);
      }, { timeout: 5000 });
    });
  });
});

describe('resumePrWait', () => {
  let resumePrWait: typeof import('@/lib/pipeline/start-pr-wait').resumePrWait;
  let getJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [] }), stderr: '' });
    getJobMock = vi.fn();
    markDoneMock = vi.fn().mockResolvedValue(undefined);
    updateJobMock = vi.fn();

    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: () => '/path/to/proj' }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs' }) }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(),
      markDone: markDoneMock,
      updateJob: updateJobMock,
      getJob: getJobMock,
    }));
    vi.doMock('@/lib/pipeline/start-mark-dod', () => ({ startMarkDod: vi.fn().mockResolvedValue({ ok: true, verified: 0, total: 0, changed: false }) }));

    ({ resumePrWait } = await import('@/lib/pipeline/start-pr-wait'));
  });

  afterEach(() => { vi.resetModules(); });

  it('returns error when job is not found', () => {
    getJobMock.mockReturnValue(null);
    expect(resumePrWait('missing')).toEqual({ ok: false, error: 'job not found' });
  });

  it('returns error when job kind is wrong', () => {
    getJobMock.mockReturnValue({ id: 'x', kind: 'test', finishedAt: null, contextMeta: '{}' });
    expect(resumePrWait('x')).toEqual({ ok: false, error: 'not a pr-wait job' });
  });

  it('returns error when job already finished', () => {
    getJobMock.mockReturnValue({ id: 'x', kind: 'pr-wait', finishedAt: 1, contextMeta: '{}' });
    expect(resumePrWait('x')).toEqual({ ok: false, error: 'job already finished' });
  });

  it('returns error when contextMeta is missing', () => {
    getJobMock.mockReturnValue({ id: 'x', kind: 'pr-wait', finishedAt: null, contextMeta: null });
    const r = resumePrWait('x');
    expect(r.ok).toBe(false);
  });

  it('returns error when contextMeta is malformed', () => {
    getJobMock.mockReturnValue({ id: 'x', kind: 'pr-wait', finishedAt: null, contextMeta: '{"prNumber":"not-a-number"}' });
    const r = resumePrWait('x');
    expect(r.ok).toBe(false);
  });

  it('resumes wait loop with parsed contextMeta', async () => {
    getJobMock.mockReturnValue({
      id: 'myproj-pr-wait-resume',
      project: 'myproj',
      kind: 'pr-wait',
      finishedAt: null,
      logPath: '/tmp/tamtam-test-logs/myproj-pr-wait-resume.log',
      contextMeta: JSON.stringify({ prNumber: 7, prRepo: 'o/r', prUrl: 'https://github.com/o/r/pull/7' }),
    });
    const r = resumePrWait('myproj-pr-wait-resume');
    expect(r).toEqual({ ok: true });
    // Loop runs against PR #7 — first gh pr view should target it
    await vi.waitFor(() => {
      expect(execMock).toHaveBeenCalled();
      const call = execMock.mock.calls.find(c => c[0] === 'gh');
      expect(call?.[1]).toContain('7');
    }, { timeout: 2000 });
  });

  it('canonicalizes legacy stale pid rows to inline pid=0 before resuming', () => {
    const job = {
      id: 'legacy-pr-wait',
      project: 'myproj',
      kind: 'pr-wait',
      pid: 424242,
      finishedAt: null,
      logPath: '/tmp/tamtam-test-logs/legacy-pr-wait.log',
      contextMeta: JSON.stringify({ prNumber: 8, prRepo: 'o/r', prUrl: 'https://github.com/o/r/pull/8' }),
    };
    getJobMock.mockReturnValue(job);

    const result = resumePrWait('legacy-pr-wait');

    expect(result).toEqual({ ok: true });
    expect(job.pid).toBe(0);
    expect(updateJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'legacy-pr-wait',
      pid: 0,
    }));
  });
});
