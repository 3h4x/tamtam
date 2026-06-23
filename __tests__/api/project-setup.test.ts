import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

const mocks = vi.hoisted(() => ({
  resolveProjectPath: vi.fn(),
  clearProjectDataCache: vi.fn(),
  exec: vi.fn(),
  detectTestCommand: vi.fn(),
  detectMainBranch: vi.fn(),
  writeFileConfig: vi.fn(),
  getSettings: vi.fn(),
}));

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
}

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  await sharedHandle[Symbol.asyncDispose]();
});

vi.mock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
  clearProjectDataCache: mocks.clearProjectDataCache,
}));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/pipeline/start-test', () => ({ detectTestCommand: mocks.detectTestCommand }));
vi.mock('@/lib/pipeline/start-commit', () => ({ detectMainBranch: mocks.detectMainBranch }));
vi.mock('@/lib/skills/tamtam-file-config', () => ({ writeFileConfig: mocks.writeFileConfig }));
vi.mock('@/lib/shared/config', () => ({ getSettings: mocks.getSettings }));

describe('/api/projects/by-project/[projectName]/setup', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/setup/route').GET;
  let PATCH: typeof import('@/app/api/projects/by-project/[projectName]/setup/route').PATCH;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE projects'));
    await sharedHandle.db.insert(schema.projects).values({
      name: 'proj1',
      path: '/tmp/proj1',
      enabled: true,
    });
    mocks.resolveProjectPath.mockReset().mockReturnValue('/tmp/proj1');
    mocks.clearProjectDataCache.mockReset();
    mocks.exec.mockReset().mockResolvedValue({ exitCode: 0, stdout: 'git@github.com:owner/proj1.git\n', stderr: '' });
    mocks.detectTestCommand.mockReset().mockResolvedValue('pnpm test');
    mocks.detectMainBranch.mockReset().mockResolvedValue('main');
    mocks.writeFileConfig.mockReset();
    mocks.getSettings.mockReset().mockReturnValue({ github_owner: 'owner' });
    const mod = await import('@/app/api/projects/by-project/[projectName]/setup/route');
    GET = mod.GET;
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns detection data and persisted setup state', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/setup');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      project: 'proj1',
      setup_complete: false,
      setup_state: {},
      detection: {
        test_command: 'pnpm test',
        default_branch: 'main',
        github_remote: 'git@github.com:owner/proj1.git',
        github_repo: 'owner/proj1',
        gh_auth: { available: true, detail: null },
      },
    });
  });

  it('persists a completed step without completing setup', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/setup', {
      method: 'PATCH',
      body: JSON.stringify({ step: 'pipeline', status: 'completed' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.setup_complete).toBe(false);
    expect(data.setup_state).toEqual({ pipeline: 'completed' });
  });

  it('validates step and status', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/setup', {
      method: 'PATCH',
      body: JSON.stringify({ step: 'bogus', status: 'completed' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('writes optional file config through writeFileConfig', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/setup', {
      method: 'PATCH',
      body: JSON.stringify({
        write_file_config: true,
        test_command: ' pnpm test ',
        safe_users: ['alice', 'alice', ' bob '],
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/tmp/proj1', {
      test_command: 'pnpm test',
      safe_users: ['alice', 'bob'],
    });
    expect((await res.json()).setup_state).toEqual({ file_config: 'completed' });
  });

  it('marks missing steps skipped when setup is completed', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/setup', {
      method: 'PATCH',
      body: JSON.stringify({ setup_complete: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.setup_complete).toBe(true);
    expect(Object.values(data.setup_state)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });
});
