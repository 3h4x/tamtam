import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mocks. Top-level vi.mock() with vi.hoisted() lets every test
// reuse the same compiled module graph for start-test — much faster than
// calling vi.resetModules() + vi.doMock() per test.
// ─────────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getImproveConfigMock: vi.fn(),
  getProjectTestConfigMock: vi.fn(),
  resolveProjectPathMock: vi.fn(),
  refreshProjectsCacheSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  createJobMock: vi.fn(),
  listJobsMock: vi.fn(),
  probeJobStatusMock: vi.fn(),
  updateJobMock: vi.fn(),
  markDoneMock: vi.fn(),
  getLockMock: vi.fn(),
  acquireLockMock: vi.fn(),
  releaseLockMock: vi.fn(),
  isLockOwnedByActiveReleaseMock: vi.fn(),
}));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: (...args: unknown[]) => mocks.getImproveConfigMock(...args),
  getProjectTestConfig: (...args: unknown[]) => mocks.getProjectTestConfigMock(...args),
}));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...args: unknown[]) => mocks.resolveProjectPathMock(...args),
}));
vi.mock('@/lib/shared/enabled-projects', () => ({
  refreshProjectsCacheSync: (...args: unknown[]) => mocks.refreshProjectsCacheSyncMock(...args),
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...args: unknown[]) => mocks.createJobMock(...args),
  listJobs: (...args: unknown[]) => mocks.listJobsMock(...args),
  probeJobStatus: (...args: unknown[]) => mocks.probeJobStatusMock(...args),
  updateJob: (...args: unknown[]) => mocks.updateJobMock(...args),
  markDone: (...args: unknown[]) => mocks.markDoneMock(...args),
}));
// Stub heavy transitive deps that detectTestCommand doesn't need, so the
// module graph for start-test.ts is small and module init stays cheap.
vi.mock('@/lib/jobs/parent-context', () => ({ currentParent: () => null }));
vi.mock('@/lib/shared/shell', () => ({ exec: vi.fn(), shellQuote: (s: string) => s }));
vi.mock('@/lib/usage/resolve-provider', () => ({
  checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
}));
vi.mock('@/lib/jobs/project-active-job', () => ({
  findBlockingRunningJob: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: (...args: unknown[]) => mocks.getLockMock(...args),
  acquireLock: (...args: unknown[]) => mocks.acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => mocks.releaseLockMock(...args),
  isLockOwnedByActiveRelease: (...args: unknown[]) => mocks.isLockOwnedByActiveReleaseMock(...args),
}));
// Stub out the file-config loader so anything reaching wrapIfUntrusted /
// getBranchContext does not shell out to `git` (via execFileSync).
vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: () => null,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: (...args: unknown[]) => mocks.execSyncMock(...args),
  spawn: (...args: unknown[]) => mocks.spawnMock(...args),
}));

// Single top-level import — all tests below share this resolved module graph.
import { detectTestCommand, hasRunnableTestCommand, isReviewRetestJob, startProjectTest } from '@/lib/pipeline/start-test';

describe('detectTestCommand', () => {
  let projDir: string;

  beforeEach(() => {
    projDir = mkdtempSync(join(tmpdir(), 'tamtam-detect-'));
    mocks.getImproveConfigMock.mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' });
    mocks.getProjectTestConfigMock.mockReturnValue(null);
    mocks.resolveProjectPathMock.mockReset().mockReturnValue(projDir);
    mocks.refreshProjectsCacheSyncMock.mockReset();
    mocks.execSyncMock.mockReset();
    mocks.spawnMock.mockReset();
    mocks.createJobMock.mockReset().mockImplementation((project: string, kind: string, pid: number, logPath: string) => ({
      id: `${project}-${kind}-id`,
      project,
      kind,
      pid,
      logPath,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      contextMeta: null,
    }));
    mocks.listJobsMock.mockReset().mockReturnValue([]);
    mocks.probeJobStatusMock.mockReset().mockResolvedValue('done');
    mocks.updateJobMock.mockReset();
    mocks.markDoneMock.mockReset().mockImplementation(async (job: { finishedAt: number | null; exitCode: number | null }, exitCode: number) => {
      job.exitCode = exitCode;
      job.finishedAt = Date.now() / 1000;
    });
    mocks.getLockMock.mockReset().mockResolvedValue(null);
    mocks.acquireLockMock.mockReset().mockResolvedValue({ acquired: true, lock: null });
    mocks.releaseLockMock.mockReset().mockResolvedValue(undefined);
    mocks.isLockOwnedByActiveReleaseMock.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    rmSync(projDir, { recursive: true, force: true });
  });

  it('returns configured test_command when project config exists', async () => {
    mocks.getImproveConfigMock.mockReturnValue({
      projects: { myproj: { project: 'myproj', test_command: 'custom-test-runner' } },
      claudeBin: 'claude',
      logDir: '/tmp',
    });
    await expect(detectTestCommand(projDir, 'myproj')).resolves.toBe('custom-test-runner');
  });

  it('detects pnpm test when pnpm-lock.yaml exists alongside package.json with test script', async () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    await expect(detectTestCommand(projDir)).resolves.toBe('pnpm test');
  });

  it('detects npm test when no pnpm-lock.yaml', async () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    await expect(detectTestCommand(projDir)).resolves.toBe('npm test');
  });

  it('returns null when package.json has no test script', async () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    await expect(detectTestCommand(projDir)).resolves.toBeNull();
  });

  it('detects pytest when pyproject.toml exists', async () => {
    writeFileSync(join(projDir, 'pyproject.toml'), '[tool.pytest]');
    await expect(detectTestCommand(projDir)).resolves.toBe('python3 -m pytest');
  });

  it('detects pytest when requirements.txt exists (takes priority over Makefile)', async () => {
    writeFileSync(join(projDir, 'requirements.txt'), 'pytest');
    await expect(detectTestCommand(projDir)).resolves.toBe('python3 -m pytest');
  });

  it('detects forge test when foundry.toml exists', async () => {
    writeFileSync(join(projDir, 'foundry.toml'), '[profile.default]');
    await expect(detectTestCommand(projDir)).resolves.toBe('forge test');
  });

  it('detects cargo test when Cargo.toml exists', async () => {
    writeFileSync(join(projDir, 'Cargo.toml'), '[package]');
    await expect(detectTestCommand(projDir)).resolves.toBe('cargo test');
  });

  it('detects go test when go.mod exists', async () => {
    writeFileSync(join(projDir, 'go.mod'), 'module example.com/foo');
    await expect(detectTestCommand(projDir)).resolves.toBe('go test ./...');
  });

  it('detects swift test when Package.swift exists and xcode-select succeeds', async () => {
    mocks.execSyncMock.mockImplementation(() => Buffer.from(''));
    writeFileSync(join(projDir, 'Package.swift'), '// swift-tools-version:5.5');
    await expect(detectTestCommand(projDir)).resolves.toBe('swift test');
  });

  it('returns null when Package.swift exists but xcode-select is not configured', async () => {
    mocks.execSyncMock.mockImplementation(() => {
      throw new Error('xcode-select: error: unable to get active developer directory');
    });
    writeFileSync(join(projDir, 'Package.swift'), '// swift-tools-version:5.5');
    await expect(detectTestCommand(projDir)).resolves.toBeNull();
  });

  it('detects make test when Makefile has a test target', async () => {
    writeFileSync(join(projDir, 'Makefile'), 'test:\n\techo running tests\n');
    await expect(detectTestCommand(projDir)).resolves.toBe('make test');
  });

  it('returns null when Makefile exists but has no test target', async () => {
    writeFileSync(join(projDir, 'Makefile'), 'build:\n\tmake build\n');
    await expect(detectTestCommand(projDir)).resolves.toBeNull();
  });

  it('returns null for empty directory', async () => {
    await expect(detectTestCommand(projDir)).resolves.toBeNull();
  });

  it('returns null when tests_disabled=true for the project, even if a test file exists', async () => {
    mocks.getProjectTestConfigMock.mockReturnValue({ testsDisabled: true });
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    await expect(detectTestCommand(projDir, 'myproj')).resolves.toBeNull();
  });

  it('reports whether a project has a runnable host test command', async () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');

    await expect(hasRunnableTestCommand('myproj')).resolves.toBe(true);

    mocks.getProjectTestConfigMock.mockReturnValue({ testsDisabled: true });
    await expect(hasRunnableTestCommand('myproj')).resolves.toBe(false);
  });

  it('reports no runnable host test command when the project path cannot be resolved', async () => {
    mocks.resolveProjectPathMock.mockReturnValue(null);

    await expect(hasRunnableTestCommand('missing')).resolves.toBe(false);
    expect(mocks.refreshProjectsCacheSyncMock).toHaveBeenCalledOnce();
  });

  it('detects review-driven re-test job context metadata', () => {
    expect(isReviewRetestJob({
      kind: 'test',
      contextMeta: JSON.stringify({ pipelineReason: 'review-retest' }),
    })).toBe(true);
    expect(isReviewRetestJob({
      kind: 'test',
      contextMeta: JSON.stringify({ pipelineReason: 'other' }),
    })).toBe(false);
  });

  it('releases a standalone test pipeline lock when spawn errors before lock acquisition completes', async () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 12345;
    child.unref = vi.fn();
    mocks.spawnMock.mockReturnValue(child);
    let resolveAcquireLock!: () => void;
    mocks.acquireLockMock.mockImplementation(() => new Promise((resolve) => {
      resolveAcquireLock = () => resolve({ acquired: true, lock: null });
    }));

    const start = startProjectTest('myproj');
    for (let i = 0; i < 10 && child.listenerCount('error') === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    child.emit('error', new Error('spawn failed'));
    resolveAcquireLock();
    const result = await start;

    expect(result.ok).toBe(true);
    expect(mocks.markDoneMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'myproj-test-id' }), -1);
    expect(mocks.releaseLockMock).toHaveBeenCalledWith('myproj', 'myproj-test-id');
  });
});
