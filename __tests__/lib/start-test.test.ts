import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('detectTestCommand', () => {
  let projDir: string;
  let detectTestCommand: typeof import('@/lib/start-test').detectTestCommand;

  beforeEach(async () => {
    vi.resetModules();
    projDir = mkdtempSync(join(tmpdir(), 'tamtam-detect-'));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: vi.fn(),
    }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
      updateJob: vi.fn(),
      markDone: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import('@/lib/start-test');
    detectTestCommand = mod.detectTestCommand;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(projDir, { recursive: true, force: true });
  });

  it('returns configured test_command when project config exists', async () => {
    vi.resetModules();
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        projects: { myproj: { project: 'myproj', test_command: 'custom-test-runner' } },
        claudeBin: 'claude',
        logDir: '/tmp',
      }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    const mod = await import('@/lib/start-test');
    expect(mod.detectTestCommand(projDir, 'myproj')).toBe('custom-test-runner');
  });

  it('detects pnpm test when pnpm-lock.yaml exists alongside package.json with test script', () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    expect(detectTestCommand(projDir)).toBe('pnpm test');
  });

  it('detects npm test when no pnpm-lock.yaml', () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    expect(detectTestCommand(projDir)).toBe('npm test');
  });

  it('returns null when package.json has no test script', () => {
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    expect(detectTestCommand(projDir)).toBeNull();
  });

  it('detects pytest when pyproject.toml exists', () => {
    writeFileSync(join(projDir, 'pyproject.toml'), '[tool.pytest]');
    expect(detectTestCommand(projDir)).toBe('python3 -m pytest');
  });

  it('detects pytest when requirements.txt exists (takes priority over Makefile)', () => {
    writeFileSync(join(projDir, 'requirements.txt'), 'pytest');
    expect(detectTestCommand(projDir)).toBe('python3 -m pytest');
  });

  it('detects forge test when foundry.toml exists', () => {
    writeFileSync(join(projDir, 'foundry.toml'), '[profile.default]');
    expect(detectTestCommand(projDir)).toBe('forge test');
  });

  it('detects cargo test when Cargo.toml exists', () => {
    writeFileSync(join(projDir, 'Cargo.toml'), '[package]');
    expect(detectTestCommand(projDir)).toBe('cargo test');
  });

  it('detects go test when go.mod exists', () => {
    writeFileSync(join(projDir, 'go.mod'), 'module example.com/foo');
    expect(detectTestCommand(projDir)).toBe('go test ./...');
  });

  it('detects swift test when Package.swift exists', () => {
    writeFileSync(join(projDir, 'Package.swift'), '// swift-tools-version:5.5');
    expect(detectTestCommand(projDir)).toBe('swift test');
  });

  it('detects make test when Makefile has a test target', () => {
    writeFileSync(join(projDir, 'Makefile'), 'test:\n\techo running tests\n');
    expect(detectTestCommand(projDir)).toBe('make test');
  });

  it('returns null when Makefile exists but has no test target', () => {
    writeFileSync(join(projDir, 'Makefile'), 'build:\n\tmake build\n');
    expect(detectTestCommand(projDir)).toBeNull();
  });

  it('returns null for empty directory', () => {
    expect(detectTestCommand(projDir)).toBeNull();
  });

  it('returns null when tests_disabled=true for the project, even if a test file exists', async () => {
    vi.resetModules();
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue({ testsDisabled: true }),
    }));
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn() }));
    vi.doMock('@/lib/job-storage', () => ({
      createJob: vi.fn(), listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn(), updateJob: vi.fn(), markDone: vi.fn(),
    }));
    const mod = await import('@/lib/start-test');
    writeFileSync(join(projDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(projDir, 'pnpm-lock.yaml'), '');
    expect(mod.detectTestCommand(projDir, 'myproj')).toBeNull();
  });
});
