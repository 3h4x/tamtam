import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

// ─────────────────────────────────────────────────────────────────────────────
// Weekly quota gating — needs different mocks for @/lib/shared/config,
// @/lib/shared/job-control, and @/lib/usage/quota, plus the real
// checkCliStartGate. Keeps the vi.resetModules() pattern for isolation.
// ─────────────────────────────────────────────────────────────────────────────
describe('startRelease weekly quota gating', () => {
  let startReleaseQuota: typeof import('@/lib/pipeline/start-release').startRelease;
  let startProjectReviewMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');

    startProjectReviewMock = vi.fn().mockResolvedValue({ ok: true, jobId: 'review-1' });
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`,
      project,
      kind,
      pid: 0,
      logPath: '',
      prompt: null,
      startedAt: 0,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      contextMeta: null,
      userPrompt: null,
    }));
    updateJobMock = vi.fn();

    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'status') {
        return Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-list') {
        return Promise.resolve({ exitCode: 0, stdout: '0', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      isProjectArchived: vi.fn().mockReturnValue(false),
      isProjectPaused: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/shared/readiness', () => ({
      getReleaseReadinessFailure: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(),
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
      findActiveReleaseJob: vi.fn().mockReturnValue(null),
      getVerdict: vi.fn().mockReturnValue(null),
      markDone: vi.fn(),
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/git/git-utils', () => ({
      isReviewed: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({
      startProjectTest: vi.fn(),
      detectTestCommand: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/pipeline/start-review', () => ({
      startProjectReview: startProjectReviewMock,
    }));
    vi.doMock('@/lib/pipeline/start-push', () => ({
      startProjectPush: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({
      startProjectCommit: vi.fn(),
      detectMainBranch: vi.fn().mockResolvedValue('main'),
      findIssueContext: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 },
      }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn(() => ({
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
      })),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      jobsPausedResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/quota', () => ({
      getQuotaSnapshots: vi.fn().mockResolvedValue(snapshots),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/spend-guard', () => ({
      checkDailySpendCap: vi.fn().mockResolvedValue({ ok: true }),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/jobs/lifecycle', () => ({
      finalizeAbortedRelease: vi.fn(),
      finalizeReleaseJob: vi.fn(),
    }));

    ({ startRelease: startReleaseQuota } = await import('@/lib/pipeline/start-release'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not 429 a root release when only weekly quota is hot', async () => {
    const result = await startReleaseQuota('proj');

    expect(result.ok).toBe(true);
    if (result.ok && 'step' in result) {
      expect(result.step).toBe('review');
    }
    expect(startProjectReviewMock).toHaveBeenCalledOnce();
    expect(createJobMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalled();
  });
});
