import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveProjectPath: vi.fn(),
  getDb: vi.fn(),
  getSettings: vi.fn(),
  getImproveConfig: vi.fn(),
}));

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
}));
vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.getDb();
  },
  schema,
}));
vi.mock('@/lib/shared/config', () => ({
  getSettings: mocks.getSettings,
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: mocks.getImproveConfig,
}));

import { POST as postComment } from '@/app/api/projects/by-project/[projectName]/issue-comment/route';
import { POST as postClose } from '@/app/api/projects/by-project/[projectName]/issue-close/route';
import { POST as postLabel } from '@/app/api/projects/by-project/[projectName]/issue-label/route';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gh_issues_cache (
      project text PRIMARY KEY,
      repo text NOT NULL,
      prs text NOT NULL DEFAULT '[]',
      issues text NOT NULL DEFAULT '[]',
      fetched_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS gh_issue_detail_cache (
      id serial PRIMARY KEY,
      project text NOT NULL,
      number integer NOT NULL,
      payload text NOT NULL,
      fetched_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS gh_issue_detail_cache_project_number
      ON gh_issue_detail_cache(project, number)
  `));
}

function resp(exitCode: number, stdout = '', stderr = '') {
  return Promise.resolve({ exitCode, stdout, stderr });
}

function makeRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function ctx(projectName = 'proj1') {
  return { params: Promise.resolve({ projectName }) };
}

async function seedCaches(): Promise<void> {
  await sharedHandle.db.insert(schema.ghIssuesCache).values({
    project: 'proj1',
    repo: 'configured/old',
    prs: '[]',
    issues: JSON.stringify([{ number: 42, labels: ['bug'] }]),
    fetchedAt: Date.now() / 1000,
  });
  await sharedHandle.db.insert(schema.ghIssueDetailCache).values({
    project: 'proj1',
    number: 42,
    payload: JSON.stringify({ number: 42, labels: ['bug'] }),
    fetchedAt: Date.now() / 1000,
  });
}

async function countCaches(): Promise<{ list: number; detail: number }> {
  const [list, detail] = await Promise.all([
    sharedHandle.db.select().from(schema.ghIssuesCache),
    sharedHandle.db.select().from(schema.ghIssueDetailCache),
  ]);
  return { list: list.length, detail: detail.length };
}

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
  mocks.getDb.mockReturnValue(sharedHandle.db);
});

afterAll(async () => {
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

beforeEach(async () => {
  await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issue_detail_cache, gh_issues_cache'));
  mocks.exec.mockReset().mockResolvedValue(resp(0));
  mocks.resolveProjectPath.mockReset().mockReturnValue('/path/to/proj');
  mocks.getDb.mockReturnValue(sharedHandle.db);
  mocks.getSettings.mockReset().mockReturnValue({ github_owner: '' });
  mocks.getImproveConfig.mockReset().mockReturnValue({
    projects: {
      proj1: { project: 'proj1', github: 'configured/repo' },
    },
    logDir: '/tmp',
  });
});

describe('POST /api/projects/by-project/[projectName]/issue-comment', () => {
  it('uses the configured repo and invalidates the issue detail cache', async () => {
    await seedCaches();

    const res = await postComment(
      makeRequest('/api/projects/by-project/proj1/issue-comment', { number: 42, body: 'Please add a fresh repro.' }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'comment', '42', '--repo', 'configured/repo', '--body', 'Please add a fresh repro.'],
      { timeout: 15000 },
    );
    await expect(res.json()).resolves.toMatchObject({ status: 'commented', number: 42, repo: 'configured/repo' });
    await expect(countCaches()).resolves.toEqual({ list: 1, detail: 0 });
  });

  it('validates body and maps gh failures to 422', async () => {
    const invalid = await postComment(
      makeRequest('/api/projects/by-project/proj1/issue-comment', { number: 42, body: '   ' }),
      ctx(),
    );
    expect(invalid.status).toBe(400);

    mocks.exec.mockResolvedValueOnce(resp(1, '', 'comment denied'));
    const failed = await postComment(
      makeRequest('/api/projects/by-project/proj1/issue-comment', { number: 42, body: 'hello' }),
      ctx(),
    );
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toMatchObject({ detail: 'comment denied' });
  });
});

describe('POST /api/projects/by-project/[projectName]/issue-close', () => {
  it('uses the configured repo and invalidates detail and list caches', async () => {
    await seedCaches();

    const res = await postClose(
      makeRequest('/api/projects/by-project/proj1/issue-close', {
        number: 42,
        reason: 'not planned',
        comment: 'No longer actionable on current HEAD.',
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '42', '--repo', 'configured/repo', '--reason', 'not planned', '--comment', 'No longer actionable on current HEAD.'],
      { timeout: 15000 },
    );
    await expect(countCaches()).resolves.toEqual({ list: 0, detail: 0 });
  });

  it('validates reason and maps gh failures to 422', async () => {
    const invalid = await postClose(
      makeRequest('/api/projects/by-project/proj1/issue-close', { number: 42, reason: 'stale' }),
      ctx(),
    );
    expect(invalid.status).toBe(400);

    mocks.exec.mockResolvedValueOnce(resp(1, '', 'close denied'));
    const failed = await postClose(
      makeRequest('/api/projects/by-project/proj1/issue-close', { number: 42, reason: 'completed' }),
      ctx(),
    );
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toMatchObject({ detail: 'close denied' });
  });
});

describe('POST /api/projects/by-project/[projectName]/issue-label', () => {
  it('uses the configured repo and invalidates detail and list caches', async () => {
    await seedCaches();

    const res = await postLabel(
      makeRequest('/api/projects/by-project/proj1/issue-label', {
        number: 42,
        addLabels: ['needs-info'],
        removeLabels: ['bug'],
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.exec).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['label', 'create', 'needs-info', '--repo', 'configured/repo', '--color', 'FBCA04'],
      { timeout: 10000 },
    );
    expect(mocks.exec).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'edit', '42', '--repo', 'configured/repo', '--add-label', 'needs-info', '--remove-label', 'bug'],
      { timeout: 15000 },
    );
    await expect(countCaches()).resolves.toEqual({ list: 0, detail: 0 });
  });

  it('validates labels and maps gh failures to 422', async () => {
    const invalid = await postLabel(
      makeRequest('/api/projects/by-project/proj1/issue-label', { number: 42, addLabels: ['bad\nlabel'] }),
      ctx(),
    );
    expect(invalid.status).toBe(400);

    mocks.exec.mockResolvedValueOnce(resp(1, '', 'label create denied'));
    const failedCreate = await postLabel(
      makeRequest('/api/projects/by-project/proj1/issue-label', { number: 42, addLabels: ['needs-info'] }),
      ctx(),
    );
    expect(failedCreate.status).toBe(422);
    await expect(failedCreate.json()).resolves.toMatchObject({
      detail: 'gh label create needs-info: label create denied',
    });

    mocks.exec
      .mockResolvedValueOnce(resp(0))
      .mockResolvedValueOnce(resp(1, '', 'edit denied'));
    const failedEdit = await postLabel(
      makeRequest('/api/projects/by-project/proj1/issue-label', { number: 42, addLabels: ['needs-info'] }),
      ctx(),
    );
    expect(failedEdit.status).toBe(422);
    await expect(failedEdit.json()).resolves.toMatchObject({ detail: 'edit denied' });
  });
});
