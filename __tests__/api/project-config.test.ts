import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Hoisted mock state shared across describe blocks. Each test mutates
// these refs to vary behavior without paying for vi.resetModules() +
// re-import on every test. The route module is imported exactly once.
const state = vi.hoisted(() => ({
  projectPath: '' as string | null,
  projectRow: undefined as {
    website?: string | null;
    qaUrl?: string | null;
    devServerStartCommand?: string | null;
    devServerStopCommand?: string | null;
    devServerReadyUrl?: string | null;
  } | undefined,
  testCfg: null as Record<string, unknown> | null,
  pushResult: null as Record<string, unknown> | null,
  pipelinePrompts: {
    reviewPromptAddendum: null as string | null,
    reviewPrerequisiteCommand: null as string | null,
    fixPromptAddendum: null as string | null,
  },
  fileConfig: null as Record<string, unknown> | null,
  branchCtx: { currentBranch: 'main', defaultBranch: 'main', isDefaultBranch: true },
  improveProjects: {} as Record<string, unknown>,
  parseTestScheduleToCronImpl: ((s: string) => {
    if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
    return s;
  }) as (s: string) => string,
}));

const mocks = vi.hoisted(() => ({
  resolveProjectPath: vi.fn(),
  clearProjectDataCache: vi.fn(),
  reloadConfig: vi.fn(),
  writeProjectFieldYaml: vi.fn(),
  getProjectTestConfig: vi.fn(),
  getProjectPushResult: vi.fn(),
  getProjectPipelinePrompts: vi.fn(),
  installTestSchedule: vi.fn(),
  uninstallTestSchedule: vi.fn(),
  loadFileConfig: vi.fn(),
  writeFileConfig: vi.fn(),
  getBranchContext: vi.fn(),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
  clearProjectDataCache: mocks.clearProjectDataCache,
}));

vi.mock('@/lib/db', () => {
  const rows = () => (state.projectRow ? [state.projectRow] : []);
  const whereResult = {
    get: () => state.projectRow,
    limit: () => Promise.resolve(rows()),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows()).then(onFulfilled, onRejected),
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => whereResult,
        }),
      }),
    },
    schema: {
      projects: { name: 'name' },
    },
  };
});

vi.mock('@/lib/shared/config', () => ({ reloadConfig: mocks.reloadConfig }));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: vi.fn(() => ({ projects: state.improveProjects, claudeBin: 'claude', logDir: '/tmp/logs' })),
  writeProjectFieldYaml: mocks.writeProjectFieldYaml,
  getProjectTestConfig: mocks.getProjectTestConfig,
  getProjectPushResult: mocks.getProjectPushResult,
  getProjectPipelinePrompts: mocks.getProjectPipelinePrompts,
}));

vi.mock('@/lib/scheduling/test-scheduler', () => ({
  installTestSchedule: mocks.installTestSchedule,
  uninstallTestSchedule: mocks.uninstallTestSchedule,
  parseTestScheduleToCron: (s: string) => state.parseTestScheduleToCronImpl(s),
}));

vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: mocks.loadFileConfig,
  writeFileConfig: mocks.writeFileConfig,
  getBranchContext: mocks.getBranchContext,
}));

const routeModulePromise = import('@/app/api/projects/by-project/[projectName]/config/route');

function resetMocks() {
  mocks.resolveProjectPath.mockReset();
  mocks.clearProjectDataCache.mockReset();
  mocks.reloadConfig.mockReset();
  mocks.writeProjectFieldYaml.mockReset();
  mocks.getProjectTestConfig.mockReset();
  mocks.getProjectPushResult.mockReset();
  mocks.getProjectPipelinePrompts.mockReset();
  mocks.installTestSchedule.mockReset();
  mocks.uninstallTestSchedule.mockReset();
  mocks.loadFileConfig.mockReset();
  mocks.writeFileConfig.mockReset();
  mocks.getBranchContext.mockReset();
  state.projectRow = undefined;
  state.improveProjects = {};
  state.parseTestScheduleToCronImpl = (s: string) => {
    if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
    return s;
  };
}

describe('GET /api/projects/by-project/{projectName}/config', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/config/route').GET;
  let tempDir: string;

  beforeAll(async () => {
    ({ GET } = await routeModulePromise);
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-config-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetMocks();
    // Defaults sufficient for most tests; individual tests override as needed.
    mocks.resolveProjectPath.mockReturnValue(tempDir);
    mocks.writeProjectFieldYaml.mockReturnValue(true);
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoCommitEnabled: false,
      autoPushEnabled: false,
      releaseAfterRun: false,
    });
    mocks.getProjectPushResult.mockReturnValue(null);
    mocks.getProjectPipelinePrompts.mockReturnValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: null,
      fixPromptAddendum: null,
    });
    mocks.loadFileConfig.mockReturnValue(null);
    mocks.getBranchContext.mockReturnValue({ currentBranch: 'main', defaultBranch: 'main', isDefaultBranch: true });
  });

  afterEach(() => {
    // Clean any files written into the shared tempDir so file-detection tests
    // don't bleed into each other. Tests don't create subdirectories here.
    for (const name of readdirSync(tempDir)) {
      try {
        const p = join(tempDir, name);
        if (statSync(p).isFile()) unlinkSync(p);
      } catch {
        // ignore
      }
    }
  });

  it('returns 404 when project not found', async () => {
    mocks.resolveProjectPath.mockReturnValue(null);
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
    expect(data.review_prerequisite_command).toBe('');
    expect(data.fix_prompt_addendum).toBe('');
    expect(data.website).toBe('');
  });

  it('surfaces review/fix prompt addenda when set', async () => {
    mocks.getProjectPipelinePrompts.mockReturnValue({
      reviewPromptAddendum: 'Be lenient.',
      reviewPrerequisiteCommand: 'pnpm db:types',
      fixPromptAddendum: 'Minimal diffs.',
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.review_prompt_addendum).toBe('Be lenient.');
    expect(data.review_prerequisite_command).toBe('pnpm db:types');
    expect(data.fix_prompt_addendum).toBe('Minimal diffs.');
  });

  it('prefers file-backed review_prerequisite_command over the DB fallback', async () => {
    mocks.loadFileConfig.mockReturnValue({
      review_prerequisite_command: 'pnpm run supabase-gen-types',
    });
    mocks.getProjectPipelinePrompts.mockReturnValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: 'pnpm db:types',
      fixPromptAddendum: null,
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.review_prerequisite_command).toBe('pnpm run supabase-gen-types');
    expect(data.file_config).toContain('review_prerequisite_command');
  });

  it('returns issue_auto_branch=true by default — Work-on branch provision is on unless explicitly disabled', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.issue_auto_branch).toBe(true);
  });

  it('surfaces issue_auto_branch=false when the per-project config flips it off', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoCommitEnabled: false,
      autoPushEnabled: false,
      releaseAfterRun: false,
      autoPrMergeEnabled: false,
      issueAutoBranch: false,
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.issue_auto_branch).toBe(false);
  });

  it('surfaces tests_disabled=true when config has it set', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoCommitEnabled: false,
      autoPushEnabled: false,
      releaseAfterRun: false,
      testsDisabled: true,
      reviewDisabled: false,
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.tests_disabled).toBe(true);
    expect(data.review_disabled).toBe(false);
  });

  it('surfaces review_disabled=true when config has it set', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoCommitEnabled: false,
      autoPushEnabled: false,
      releaseAfterRun: false,
      testsDisabled: false,
      reviewDisabled: true,
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.tests_disabled).toBe(false);
    expect(data.review_disabled).toBe(true);
  });

  it('returns auto_push_enabled from config when set', async () => {
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: null,
      testCronEnabled: false,
      testCronSchedule: null,
      autoCommitEnabled: true,
      autoPushEnabled: true,
      releaseAfterRun: true,
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.auto_commit_enabled).toBe(true);
    expect(data.auto_push_enabled).toBe(true);
    expect(data.release_after_run).toBe(true);
  });

  it('surfaces the stored website URL when present', async () => {
    state.projectRow = { website: 'https://example.com/app' };
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.website).toBe('https://example.com/app');
  });

  it('surfaces stored dev server lifecycle commands when present', async () => {
    state.projectRow = {
      devServerStartCommand: 'pnpm dev',
      devServerStopCommand: 'pnpm dev:stop',
      devServerReadyUrl: 'http://localhost:3000/health',
    };
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.dev_server_start_command).toBe('pnpm dev');
    expect(data.dev_server_stop_command).toBe('pnpm dev:stop');
    expect(data.dev_server_ready_url).toBe('http://localhost:3000/health');
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

    state.improveProjects = {
      proj1: {
        project: 'proj1',
        path: tempDir,
        test_command: 'custom test cmd',
        prompt: '',
        validate: false,
        persona: [],
        scheduler: null,
        github: null,
        priority: null,
      },
    };
    mocks.getProjectTestConfig.mockReturnValue({
      testCommand: 'custom test cmd',
      testCronEnabled: false,
      testCronSchedule: null,
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.test_command).toBe('custom test cmd');
    expect(data.effective_test_command).toBe('custom test cmd');
  });
});

describe('PATCH /api/projects/by-project/{projectName}/config', () => {
  let PATCH: typeof import('@/app/api/projects/by-project/[projectName]/config/route').PATCH;

  beforeAll(async () => {
    ({ PATCH } = await routeModulePromise);
  });

  beforeEach(() => {
    resetMocks();
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.writeProjectFieldYaml.mockReturnValue(true);
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null });
    mocks.getProjectPushResult.mockReturnValue(null);
    mocks.getProjectPipelinePrompts.mockReturnValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: null,
      fixPromptAddendum: null,
    });
    mocks.loadFileConfig.mockReturnValue(null);
    mocks.getBranchContext.mockReturnValue({ currentBranch: 'main', defaultBranch: 'main', isDefaultBranch: true });
  });

  it('returns 404 when project not found', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_command', 'pnpm test');
  });

  it('clears test_command when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_command', null);
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.writeFileConfig).not.toHaveBeenCalled();
  });

  it('persists commit_style to the project file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: '  Use cyberpunk vocabulary.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
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
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
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
    expect(mocks.writeFileConfig).not.toHaveBeenCalled();
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('returns 500 when writing file-backed config fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
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
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('does not apply DB test_command when a mixed file-backed config write fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
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
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
      test_command: 'pnpm test',
      commit_style: 'cyberpunk only',
    });
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('does not apply DB workflow flags when a mixed file-backed config write fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('calls reloadConfig and clearProjectDataCache after update', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pytest' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.reloadConfig).toHaveBeenCalledOnce();
    expect(mocks.clearProjectDataCache).toHaveBeenCalledOnce();
  });

  it('persists a trimmed website URL to the DB-only project config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '  https://example.com/app  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'website', 'https://example.com/app');
  });

  it('clears website when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '   ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'website', null);
  });

  it('persists trimmed dev server lifecycle fields to DB-only project config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        dev_server_start_command: '  pnpm dev  ',
        dev_server_stop_command: '  pnpm dev:stop  ',
        dev_server_ready_url: '  http://localhost:3000/ready  ',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_start_command', 'pnpm dev');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_stop_command', 'pnpm dev:stop');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_ready_url', 'http://localhost:3000/ready');
  });

  it('clears dev server lifecycle fields when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        dev_server_start_command: '   ',
        dev_server_stop_command: '   ',
        dev_server_ready_url: '   ',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_start_command', null);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_stop_command', null);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_ready_url', null);
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects invalid dev server ready URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ dev_server_ready_url: 'not a url' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('valid URL');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'dev_server_ready_url', expect.anything());
  });

  it('rejects non-http dev server ready URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ dev_server_ready_url: 'ftp://localhost/ready' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('http(s)');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'dev_server_ready_url', expect.anything());
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('returns ok without writing when body has no test_command', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ other_field: 'value' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('persists issue_auto_branch=false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '0');
  });

  it('persists issue_auto_branch=true (re-enabling Work-on branch provision)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '1');
  });

  it('persists tests_disabled=true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'tests_disabled', '1');
  });

  it('persists tests_disabled=false (re-enabling tests)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'tests_disabled', '0');
  });

  it('returns 404 when tests_disabled is set but project not found', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_disabled', '1');
  });

  it('persists review_disabled=false (re-enabling review)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_disabled', '0');
  });

  it('returns 404 when project not found while writing review_disabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists test_cron_schedule and test_cron_enabled', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '1h' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_schedule', '1h');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_enabled', '1');
  });

  it('installs PM2 schedule when cron is enabled with schedule', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '30m' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '30m' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.installTestSchedule).toHaveBeenCalledWith('proj1', '30m');
    expect(mocks.uninstallTestSchedule).not.toHaveBeenCalled();
  });

  it('uninstalls PM2 schedule when cron is disabled', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: false }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.uninstallTestSchedule).toHaveBeenCalledWith('proj1');
    expect(mocks.installTestSchedule).not.toHaveBeenCalled();
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('clears test_cron_schedule when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_schedule', null);
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('writes auto_commit_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '1');
  });

  it('writes auto_commit_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '0');
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('returns 404 when project not found while writing auto_commit_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'release_after_run', '1');
  });

  it('writes release_after_run=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'release_after_run', '0');
  });

  it('returns 404 when project not found while writing release_after_run', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '1');
  });

  it('writes auto_pr_merge_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_pr_merge_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '1');
  });

  it('writes auto_push_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_push_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('persists review_prerequisite_command text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: 'pnpm db:types' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', 'pnpm db:types');
  });

  it('trims review_prerequisite_command before persisting', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: '  pnpm db:types  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', 'pnpm db:types');
  });

  it('clears review_prerequisite_command when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: '   \n  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', null);
  });

  it('rejects non-string review_prerequisite_command payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: ['bad'] }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('review_prerequisite_command must be a string');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('trims review_prompt_addendum before persisting', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '  Treat console.log as non-blocker.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('clears review_prompt_addendum when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '   \n  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', null);
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
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('persists fix_prompt_addendum text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ fix_prompt_addendum: 'Prefer minimal diffs.' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'fix_prompt_addendum', 'Prefer minimal diffs.');
  });

  it('returns 404 when project not found while writing review_prompt_addendum', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
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

  beforeAll(async () => {
    // Import the real implementation, bypassing the module-scope mock for
    // `@/lib/scheduling/test-scheduler` in this file.
    const mod = await vi.importActual<typeof import('@/lib/scheduling/test-scheduler')>(
      '@/lib/scheduling/test-scheduler'
    );
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
    const res = await mod.GET(new NextRequest('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});
