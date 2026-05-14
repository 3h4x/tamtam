import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('detectTestCommand', () => {
  let projDir: string;
  let detectTestCommand: typeof import('@/lib/pipeline/start-test').detectTestCommand;

  beforeEach(async () => {
    vi.resetModules();
    projDir = mkdtempSync(join(tmpdir(), 'tamtam-detect-'));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn(),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
      updateJob: vi.fn(),
      markDone: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import('@/lib/pipeline/start-test');
    detectTestCommand = mod.detectTestCommand;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(projDir, { recursive: true, force: true });
  });

  it('returns configured test_command when project config exists', async () => {
    vi.resetModules();
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        projects: { myproj: { project: 'myproj', test_command: 'custom-test-runner' } },
        claudeBin: 'claude',
        logDir: '/tmp',
      }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    const mod = await import('@/lib/pipeline/start-test');
    await expect(mod.detectTestCommand(projDir, 'myproj')).resolves.toBe('custom-test-runner');
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
    vi.resetModules();
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    vi.doMock('child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('child_process')>()),
      execSync: vi.fn(), // no-op = success
    }));
    const mod = await import('@/lib/pipeline/start-test');
    writeFileSync(join(projDir, 'Package.swift'), '// swift-tools-version:5.5');
    await expect(mod.detectTestCommand(projDir)).resolves.toBe('swift test');
  });

  it('returns null when Package.swift exists but xcode-select is not configured', async () => {
    vi.resetModules();
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    vi.doMock('child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('child_process')>()),
      execSync: vi.fn().mockImplementation(() => { throw new Error('xcode-select: error: unable to get active developer directory'); }),
    }));
    const mod = await import('@/lib/pipeline/start-test');
    writeFileSync(join(projDir, 'Package.swift'), '// swift-tools-version:5.5');
    await expect(mod.detectTestCommand(projDir)).resolves.toBeNull();
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
    vi.resetModules();
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue({ testsDisabled: true }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    const mod = await import('@/lib/pipeline/start-test');
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    await expect(mod.detectTestCommand(projDir, 'myproj')).resolves.toBeNull();
  });
});
