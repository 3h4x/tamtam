import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Legacy review stamp compatibility — uses the real git-utils module with an
// os.homedir override pointing at a temp cache dir, so this describe keeps the
// vi.resetModules() + vi.doMock pattern. Only one test, so the cost is bounded.
// ─────────────────────────────────────────────────────────────────────────────
describe('startRelease — legacy review stamp compatibility', () => {
  let startReleaseLegacy: typeof import('@/lib/pipeline/start-release').startRelease;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let getVerdictMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let markDoneMock: ReturnType<typeof vi.fn>;
  let startProjectPushMock: ReturnType<typeof vi.fn>;

  let tempDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    vi.resetModules();

    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-release-legacy-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'tamtam-release-cache-'));

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return {
        ...actual,
        homedir: () => cacheDir,
      };
    });

    resolveProjectPathMock = vi.fn().mockReturnValue(join(tempDir, 'proj'));
    listJobsMock = vi.fn().mockReturnValue([
      { id: 'review-legacy', project: 'proj', kind: 'review', finishedAt: 100, exitCode: 0 },
    ]);
    getVerdictMock = vi.fn().mockReturnValue('LGTM');
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-rel-id`, project, kind, pid: 0, logPath: '',
      prompt: null, startedAt: 0, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      contextMeta: null, userPrompt: null,
    }));
    updateJobMock = vi.fn();
    markDoneMock = vi.fn();
    startProjectPushMock = vi.fn().mockResolvedValue({ ok: true, commitSha: 'abc', message: 'pushed' });

    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'status') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-list') {
        return Promise.resolve({ exitCode: 0, stdout: '1\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD') {
        return Promise.resolve({ exitCode: 0, stdout: 'head-a\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '@{u}') {
        return Promise.resolve({ exitCode: 0, stdout: 'upstream-a\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    mkdirSync(join(cacheDir, '.cache', 'tamtam', 'schedule-reviews'), { recursive: true });
    writeFileSync(
      join(cacheDir, '.cache', 'tamtam', 'schedule-reviews', 'proj.hash'),
      'da39a3ee5e6b4b0d3255bfef95601890afd80709\n',
    );

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      isProjectArchived: vi.fn().mockReturnValue(false),
      isProjectPaused: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/shared/readiness', () => ({
      getReleaseReadinessFailure: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/git/git-utils', async () => {
      const actual = await vi.importActual<typeof import('@/lib/git/git-utils')>('@/lib/git/git-utils');
      return actual;
    });
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: vi.fn(),
      createJob: createJobMock,
      updateJob: updateJobMock,
      getJob: vi.fn().mockReturnValue(null),
      getVerdict: getVerdictMock,
      markDone: markDoneMock,
      runWithParent: <T,>(_p: string, fn: () => T | Promise<T>) => fn(),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: () => null,
    }));
    vi.doMock('@/lib/pipeline/start-test', () => ({ startProjectTest: vi.fn(), detectTestCommand: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/pipeline/start-review', () => ({ startProjectReview: vi.fn() }));
    vi.doMock('@/lib/pipeline/start-push', () => ({ startProjectPush: startProjectPushMock }));
    vi.doMock('@/lib/pipeline/start-commit', () => ({ startProjectCommit: vi.fn() }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true, lock: { project: 'proj', lockedByJobId: 'test', acquiredAt: Date.now() / 1000 } }),
      releaseLock: vi.fn(),
      reassignLock: vi.fn(),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
      getLock: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }) }));
    vi.doMock('@/lib/pipeline/spend-guard', () => ({
      checkDailySpendCap: vi.fn().mockResolvedValue({ ok: true }),
    }));
    vi.doMock('@/lib/shared/notifications', () => ({
      notify: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));

    ({ startRelease: startReleaseLegacy } = await import('@/lib/pipeline/start-release'));
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('pushes directly when a legacy plain-hash review stamp still matches', async () => {
    const result = await startReleaseLegacy('proj');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step).toBe('push');
    expect(startProjectPushMock).toHaveBeenCalledWith('proj');
    expect(readFileSync(join(cacheDir, '.cache', 'tamtam', 'schedule-reviews', 'proj.hash'), 'utf-8')).toContain('"version":1');
  });
});
