import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/config', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;
  let projectRow: { website?: string | null; qaUrl?: string | null } | undefined;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-config-test-'));
    projectRow = undefined;

    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              get: () => projectRow,
            }),
          }),
        }),
      },
      schema: {
        projects: {
          name: 'name',
        },
      },
    }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({
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
    expect(data.release_timeout_minutes).toBeNull();
    expect(data.detected_test_command).toBe('');
    expect(data.effective_test_command).toBe('');
  });

  it('surfaces release_timeout_minutes from the file config when set', async () => {
    mkdirSync(join(tempDir, '.tamtam'), { recursive: true });
    writeFileSync(join(tempDir, '.tamtam', 'config.yml'), 'pipeline:\n  release_timeout_minutes: 45\n');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(data.release_timeout_minutes).toBe(45);
    expect(data.file_config).toContain('release_timeout_minutes');
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

  it('returns auto_pr_merge_enabled=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_pr_merge_enabled).toBe(false);
  });

  it('returns auto_push_enabled=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_push_enabled).toBe(false);
  });

  it('returns tests_disabled=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.tests_disabled).toBe(false);
  });

  it('returns review_disabled=false by default', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.review_disabled).toBe(false);
  });

  it('returns empty review/fix prompt addenda when none set', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.review_prompt_addendum).toBe('');
    expect(data.fix_prompt_addendum).toBe('');
    expect(data.website).toBe('');
  });

  it('surfaces review/fix prompt addenda when set', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: 'Be lenient.', fixPromptAddendum: 'Minimal diffs.' }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.review_prompt_addendum).toBe('Be lenient.');
    expect(data.fix_prompt_addendum).toBe('Minimal diffs.');
  });

  it('returns issue_auto_branch=true by default — Work-on branch provision is on unless explicitly disabled', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.issue_auto_branch).toBe(true);
  });

  it('surfaces issue_auto_branch=false when the per-project config flips it off', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({
        testCommand: null, testCronEnabled: false, testCronSchedule: null,
        autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false, autoPrMergeEnabled: false,
        issueAutoBranch: false,
      }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.issue_auto_branch).toBe(false);
  });

  it('surfaces tests_disabled=true when config has it set', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({
        testCommand: null, testCronEnabled: false, testCronSchedule: null,
        autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false,
        testsDisabled: true, reviewDisabled: false,
      }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.tests_disabled).toBe(true);
    expect(data.review_disabled).toBe(false);
  });

  it('surfaces review_disabled=true when config has it set', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({
        testCommand: null, testCronEnabled: false, testCronSchedule: null,
        autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false,
        testsDisabled: false, reviewDisabled: true,
      }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.tests_disabled).toBe(false);
    expect(data.review_disabled).toBe(true);
  });

  it('returns auto_push_enabled from config when set', async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock, clearProjectDataCache: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null, autoCommitEnabled: true, autoPushEnabled: true, releaseAfterRun: true }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({ installTestSchedule: vi.fn(), uninstallTestSchedule: vi.fn(), parseTestScheduleToCron: (s: string) => s }));
    const { GET: GET2 } = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_commit_enabled).toBe(true);
    expect(data.auto_push_enabled).toBe(true);
    expect(data.release_after_run).toBe(true);
  });

  it('surfaces the stored website URL when present', async () => {
    projectRow = { website: 'https://example.com/app' };
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.website).toBe('https://example.com/app');
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
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        projects: { 'proj1': { project: 'proj1', path: tempDir, test_command: 'custom test cmd', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null } },
        claudeBin: 'claude',
        logDir: '/tmp/logs',
      }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
      getProjectTestConfig: vi.fn().mockReturnValue({ testCommand: 'custom test cmd', testCronEnabled: false, testCronSchedule: null }),
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({
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
  let writeFileConfigMock: ReturnType<typeof vi.fn>;
  let projectRow: { website?: string | null; qaUrl?: string | null } | undefined;

  beforeEach(async () => {
    vi.resetModules();
    projectRow = undefined;

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    writeProjectFieldYamlMock = vi.fn().mockReturnValue(true);
    getProjectTestConfigMock = vi.fn().mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null });
    reloadConfigMock = vi.fn();
    clearProjectDataCacheMock = vi.fn();
    installTestScheduleMock = vi.fn();
    uninstallTestScheduleMock = vi.fn();
    writeFileConfigMock = vi.fn();

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              get: () => projectRow,
            }),
          }),
        }),
      },
      schema: {
        projects: {
          name: 'name',
        },
      },
    }));
    vi.doMock('@/lib/shared/config', () => ({ reloadConfig: reloadConfigMock }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: vi.fn().mockReturnValue(null),
      writeFileConfig: writeFileConfigMock,
      getBranchContext: vi.fn().mockReturnValue({
        currentBranch: 'main',
        defaultBranch: 'main',
        isDefaultBranch: true,
      }),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: writeProjectFieldYamlMock,
      getProjectTestConfig: getProjectTestConfigMock,
      getProjectPushResult: vi.fn().mockReturnValue(null),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ reviewPromptAddendum: null, fixPromptAddendum: null }),
    }));
    vi.doMock('@/lib/scheduling/test-scheduler', () => ({
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

  it('persists release_timeout_minutes to the project file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_timeout_minutes: '45' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
    expect(writeFileConfigMock).toHaveBeenCalledWith('/path/to/proj', {
      release_timeout_minutes: 45,
    });
  });

  it('clears release_timeout_minutes from the project file config when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_timeout_minutes: '   ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeFileConfigMock).toHaveBeenCalledWith('/path/to/proj', {
      release_timeout_minutes: null,
    });
  });

  it('rejects non-numeric release_timeout_minutes payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_timeout_minutes: 'soon' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('release_timeout_minutes must be a positive integer');
    expect(writeFileConfigMock).not.toHaveBeenCalled();
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });

  it('clears test_command when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_command', null);
  });

  it('rejects non-string test_command payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('test_command must be a string');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
    expect(writeFileConfigMock).not.toHaveBeenCalled();
  });

  it('persists commit_style to the project file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: '  Use cyberpunk vocabulary.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
    expect(writeFileConfigMock).toHaveBeenCalledWith('/path/to/proj', {
      commit_style: 'Use cyberpunk vocabulary.',
    });
  });

  it('clears commit_style from the project file config when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: '   \n  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeFileConfigMock).toHaveBeenCalledWith('/path/to/proj', {
      commit_style: null,
    });
  });

  it('rejects non-string commit_style payloads instead of clearing the file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: { tone: 'cyberpunk' } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('commit_style must be a string');
    expect(writeFileConfigMock).not.toHaveBeenCalled();
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });

  it('returns 500 when writing file-backed config fails', async () => {
    writeFileConfigMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: 'cyberpunk only' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('.tamtam/config.yml');
    expect(reloadConfigMock).not.toHaveBeenCalled();
    expect(clearProjectDataCacheMock).not.toHaveBeenCalled();
  });

  it('does not apply DB test_command when a mixed file-backed config write fails', async () => {
    writeFileConfigMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        test_command: 'pnpm test',
        commit_style: 'cyberpunk only',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    expect(writeFileConfigMock).toHaveBeenCalledWith('/path/to/proj', {
      test_command: 'pnpm test',
      commit_style: 'cyberpunk only',
    });
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
    expect(reloadConfigMock).not.toHaveBeenCalled();
    expect(clearProjectDataCacheMock).not.toHaveBeenCalled();
  });

  it('does not apply DB workflow flags when a mixed file-backed config write fails', async () => {
    writeFileConfigMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        commit_style: 'cyberpunk only',
        auto_push_enabled: true,
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
    expect(reloadConfigMock).not.toHaveBeenCalled();
    expect(clearProjectDataCacheMock).not.toHaveBeenCalled();
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

  it('persists a trimmed website URL to the DB-only project config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '  https://example.com/app  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'website', 'https://example.com/app');
  });

  it('clears website when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '   ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'website', null);
  });

  it('rejects invalid website URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: 'not a url' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('valid URL');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects non-http website URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: 'ftp://example.com/app' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('http(s)');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects boolean website payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('string URL');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects object website payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: { href: 'https://example.com/app' } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('string URL');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
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

  it('persists issue_auto_branch=false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '0');
  });

  it('persists issue_auto_branch=true (re-enabling Work-on branch provision)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '1');
  });

  it('persists tests_disabled=true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'tests_disabled', '1');
  });

  it('persists tests_disabled=false (re-enabling tests)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'tests_disabled', '0');
  });

  it('returns 404 when tests_disabled is set but project not found', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists review_disabled=true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'review_disabled', '1');
  });

  it('persists review_disabled=false (re-enabling review)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'review_disabled', '0');
  });

  it('returns 404 when review_disabled is set but project not found', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
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

  it('rejects non-string test_cron_schedule payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: 30 }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('test_cron_schedule must be a string');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
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

  it('rejects non-boolean workflow flag payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: 'false' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('auto_commit_enabled must be a boolean');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
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

  it('writes auto_pr_merge_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '1');
  });

  it('writes auto_pr_merge_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_pr_merge_enabled', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('writes auto_push_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '1');
  });

  it('writes auto_push_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_push_enabled', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists review_prompt_addendum text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: 'Treat console.log as non-blocker.' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('trims review_prompt_addendum before persisting', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '  Treat console.log as non-blocker.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('clears review_prompt_addendum when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '   \n  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', null);
  });

  it('rejects non-string review_prompt_addendum payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: ['bad'] }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('review_prompt_addendum must be a string');
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });

  it('persists fix_prompt_addendum text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ fix_prompt_addendum: 'Prefer minimal diffs.' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'fix_prompt_addendum', 'Prefer minimal diffs.');
  });

  it('returns 404 when project not found while writing review_prompt_addendum', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: 'foo' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });
});

describe('parseTestScheduleToCron', () => {
  let parseTestScheduleToCron: typeof import('@/lib/scheduling/test-scheduler').parseTestScheduleToCron;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/scheduling/test-scheduler');
    const mod = await vi.importActual<typeof import('@/lib/scheduling/test-scheduler')>('@/lib/scheduling/test-scheduler');
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
