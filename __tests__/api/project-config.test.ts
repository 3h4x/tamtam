import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/config', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-config-test-'));

    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/test-scheduler', () => ({
      installTestSchedule: vi.fn(),
      uninstallTestSchedule: vi.fn(),
      parseTestScheduleToCron: (s: string) => {
        if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
        return s;
      },
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns empty test commands when no config files exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBe('proj1');
    expect(data.test_command).toBe('');
    expect(data.detected_test_command).toBe('');
    expect(data.effective_test_command).toBe('');
  });

  it('returns auto_commit_enabled=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_commit_enabled).toBe(false);
  });

  it('returns release_after_run=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.release_after_run).toBe(false);
  });

  it('returns auto_push_enabled from config when set', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: true, releaseAfterRun: true }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_commit_enabled).toBe(true);
    expect(data.auto_push_enabled).toBe(true);
    expect(data.release_after_run).toBe(true);
  });

  it('detects pnpm test when package.json has test script and pnpm-lock.yaml exists', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('pnpm test');
  });

  it('detects npm test when package.json has test script but no pnpm-lock.yaml', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('npm test');
  });

  it('detects python -m pytest when pyproject.toml exists', async () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest.ini_options]');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('python3 -m pytest');
  });

  it('detects python -m pytest when requirements.txt exists', async () => {
    writeFileSync(join(tempDir, 'requirements.txt'), 'pytest');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('python3 -m pytest');
  });

  it('detects forge test when foundry.toml exists', async () => {
    writeFileSync(join(tempDir, 'foundry.toml'), '[profile.default]');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('forge test');
  });

  it('uses configured test_command over detected when set', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');

    vi.resetModules();
    // Mock with a configured test command
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        projects: { 'proj1': { project: 'proj1', path: tempDir, test_command: 'custom test cmd', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null } },
        claudeBin: 'claude',
        logDir: '/tmp/logs',
      }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: 'custom test cmd', testCronEnabled: false, testCronSchedule: null }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/test-scheduler', () => ({
      installTestSchedule: vi.fn(),
      uninstallTestSchedule: vi.fn(),
      parseTestScheduleToCron: (s: string) => s,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const GET2 = mod.GET;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.test_command).toBe('custom test cmd');
    expect(data.effective_test_command).toBe('custom test cmd');
  });
});

describe('PATCH /api/projects/by-project/{projectName}/config', () => {
  let PATCH: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let writeProjectFieldYamlMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let reloadConfigMock: ReturnType<typeof vi.fn>;
  let clearProjectDataCacheMock: ReturnType<typeof vi.fn>;
  let installTestScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallTestScheduleMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    writeProjectFieldYamlMock = vi.fn().mockReturnValue(true);
    getProjectTestConfigMock = vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null });
    reloadConfigMock = vi.fn();
    clearProjectDataCacheMock = vi.fn();
    installTestScheduleMock = vi.fn();
    uninstallTestScheduleMock = vi.fn();

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: reloadConfigMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: writeProjectFieldYamlMock,
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/test-scheduler', () => ({
      installTestSchedule: installTestScheduleMock,
      uninstallTestSchedule: uninstallTestScheduleMock,
      parseTestScheduleToCron: (s: string) => {
        if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
        return s;
      },
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'npm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('updates test_command and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pnpm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_command', 'pnpm test');
  });

  it('clears test_command when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_command', null);
  });

  it('calls reloadConfig and clearProjectDataCache after update', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pytest' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(reloadConfigMock).toHaveBeenCalledOnce();
    expect(clearProjectDataCacheMock).toHaveBeenCalledOnce();
  });

  it('returns ok without writing when body has no test_command', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ other_field: 'value' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });

  it('persists test_cron_schedule and test_cron_enabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '1h' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_cron_schedule', '1h');
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_cron_enabled', '1');
  });

  it('installs PM2 schedule when cron is enabled with schedule', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '30m' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '30m' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(installTestScheduleMock).toHaveBeenCalledWith('proj1', '30m');
    expect(uninstallTestScheduleMock).not.toHaveBeenCalled();
  });

  it('uninstalls PM2 schedule when cron is disabled', async () => {
    getProjectTestConfigMock.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: false }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(uninstallTestScheduleMock).toHaveBeenCalledWith('proj1');
    expect(installTestScheduleMock).not.toHaveBeenCalled();
  });

  it('rejects invalid cron schedule with 400', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: 'bogus' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Invalid schedule');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });

  it('clears test_cron_schedule when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_cron_schedule', null);
  });

  it('writes auto_commit_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '1');
  });

  it('writes auto_commit_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_commit_enabled', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('writes release_after_run=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'release_after_run', '1');
  });

  it('writes release_after_run=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'release_after_run', '0');
  });

  it('returns 404 when project not found while writing release_after_run', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });
});

describe('parseTestScheduleToCron', () => {
  let parseTestScheduleToCron: typeof import('@/lib/test-scheduler').parseTestScheduleToCron;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/test-scheduler');
    const mod = await vi.importActual<typeof import('@/lib/test-scheduler')>('@/lib/test-scheduler');
    parseTestScheduleToCron = mod.parseTestScheduleToCron;
  });

  it('converts 30m to every-30-minute cron', () => {
    expect(parseTestScheduleToCron('30m')).toBe('*/30 * * * *');
  });

  it('converts 1h to hourly cron', () => {
    expect(parseTestScheduleToCron('1h')).toBe('0 */1 * * *');
  });

  it('converts 6h to every-6-hour cron', () => {
    expect(parseTestScheduleToCron('6h')).toBe('0 */6 * * *');
  });

  it('converts 1d to daily cron at midnight', () => {
    expect(parseTestScheduleToCron('1d')).toBe('0 0 * * *');
  });

  it('passes through a raw cron expression with five parts', () => {
    expect(parseTestScheduleToCron('15 3 * * 1')).toBe('15 3 * * 1');
  });

  it('throws on unknown format', () => {
    expect(() => parseTestScheduleToCron('abc')).toThrow(/Invalid schedule/);
  });

  it('throws on non-positive duration', () => {
    expect(() => parseTestScheduleToCron('0m')).toThrow(/Invalid schedule/);
  });
});

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const mod = await import('@/app/api/health/route');
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});
