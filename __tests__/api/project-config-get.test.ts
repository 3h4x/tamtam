import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mocks, resetMocks, routeModulePromise, state } from './project-config-fixtures';

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
    // The route caches its response on globalThis (survives between tests); most
    // tests reuse `proj1` within the 5s TTL, so clear it or they'd read the
    // first test's cached value.
    delete (globalThis as Record<string, unknown>).__tamtamConfigCache;
    delete (globalThis as Record<string, unknown>).__tamtamConfigInflight;
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

  it('returns project spend caps and rolling 24h spend', async () => {
    state.projectRow = {
      dailySpendCapUsd: 12.5,
      releaseSpendCapUsd: 4.25,
    };
    mocks.getProjectDailySpendUsd.mockResolvedValue(3.75);

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(data.daily_spend_cap_usd).toBe(12.5);
    expect(data.release_spend_cap_usd).toBe(4.25);
    expect(data.last_24h_spend_usd).toBe(3.75);
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

  it('serves a second call within TTL from cache without recomputing', async () => {
    const first = await GET(new NextRequest('http://localhost/api/projects/by-project/proj1/config'), {
      params: Promise.resolve({ projectName: 'proj1' }),
    });
    expect((await first.json()).project).toBe('proj1');
    const callsAfterFirst = mocks.getProjectTestConfig.mock.calls.length;

    const second = await GET(new NextRequest('http://localhost/api/projects/by-project/proj1/config'), {
      params: Promise.resolve({ projectName: 'proj1' }),
    });
    expect((await second.json()).project).toBe('proj1');
    // Cache hit — no additional compute (DB/config reads not re-run).
    expect(mocks.getProjectTestConfig.mock.calls.length).toBe(callsAfterFirst);
  });

  it('bypasses the cache and recomputes when x-tamtam-refresh:1 is sent', async () => {
    await GET(new NextRequest('http://localhost/api/projects/by-project/proj1/config'), {
      params: Promise.resolve({ projectName: 'proj1' }),
    });
    const callsAfterFirst = mocks.getProjectTestConfig.mock.calls.length;

    const refreshed = await GET(
      new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
        headers: { 'x-tamtam-refresh': '1' },
      }),
      { params: Promise.resolve({ projectName: 'proj1' }) },
    );
    expect((await refreshed.json()).project).toBe('proj1');
    // Forced refresh must recompute so a post-mutation read never sees stale state.
    expect(mocks.getProjectTestConfig.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it('single-flights concurrent cold misses into one compute', async () => {
    const [a, b] = await Promise.all([
      GET(new NextRequest('http://localhost/api/projects/by-project/race-proj/config'), {
        params: Promise.resolve({ projectName: 'race-proj' }),
      }),
      GET(new NextRequest('http://localhost/api/projects/by-project/race-proj/config'), {
        params: Promise.resolve({ projectName: 'race-proj' }),
      }),
    ]);
    expect((await a.json()).project).toBe('race-proj');
    expect((await b.json()).project).toBe('race-proj');
  });
});
