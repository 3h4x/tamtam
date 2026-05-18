import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

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
      ON gh_issue_detail_cache (project, number)
  `));
}

type ExecResult = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: '', stderr });

function makeReq(path: string, body: unknown) {
  return new NextRequest(`http://localhost/api/projects/by-project/proj1/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function ctx(projectName = 'proj1') {
  return { params: Promise.resolve({ projectName }) };
}

async function seedDetailCache(handle: TestDbHandle, project: string, number: number) {
  await handle.db.insert(schema.ghIssueDetailCache).values({
    project, number, payload: '{}', fetchedAt: Date.now() / 1000,
  });
}

let sharedHandle: TestDbHandle;
let execMock: ReturnType<typeof vi.fn>;
let resolveProjectPathMock: ReturnType<typeof vi.fn>;
let resolveGhRepoMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 30));
  try { await sharedHandle[Symbol.asyncDispose](); } catch { /* ignore */ }
});

beforeEach(async () => {
  vi.resetModules();
  await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issues_cache'));
  await sharedHandle.db.execute(sql.raw('TRUNCATE gh_issue_detail_cache RESTART IDENTITY'));

  resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
  execMock = vi.fn().mockResolvedValue(ok());
  resolveGhRepoMock = vi.fn().mockResolvedValue('owner/repo');

  vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
  vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
  vi.doMock('@/lib/github/repo', () => ({ resolveGhRepo: resolveGhRepoMock }));
});

afterEach(() => { vi.resetModules(); });

describe('POST /issue-comment', () => {
  async function POST(req: NextRequest, c = ctx()) {
    const mod = await import('@/app/api/projects/by-project/[projectName]/issue-comment/route');
    return mod.POST(req, c);
  }

  it('returns 400 when number is missing', async () => {
    const res = await POST(makeReq('issue-comment', { body: 'hi' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is empty', async () => {
    const res = await POST(makeReq('issue-comment', { number: 5, body: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValueOnce(null);
    const res = await POST(makeReq('issue-comment', { number: 5, body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('runs gh issue comment with correct args and invalidates detail cache', async () => {
    await seedDetailCache(sharedHandle, 'proj1', 5);
    const res = await POST(makeReq('issue-comment', { number: 5, body: 'Starting work on this now.' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('commented');

    expect(execMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'comment', '5', '--repo', 'owner/repo', '--body', 'Starting work on this now.'],
      expect.objectContaining({ timeout: 15000 }),
    );

    const rows = await sharedHandle.db.select().from(schema.ghIssueDetailCache);
    expect(rows).toHaveLength(0);
  });

  it('returns 422 when gh fails', async () => {
    execMock.mockResolvedValueOnce(fail('rate limited'));
    const res = await POST(makeReq('issue-comment', { number: 5, body: 'hi' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('rate limited');
  });
});

describe('POST /issue-close', () => {
  async function POST(req: NextRequest, c = ctx()) {
    const mod = await import('@/app/api/projects/by-project/[projectName]/issue-close/route');
    return mod.POST(req, c);
  }

  it('returns 400 when reason is invalid', async () => {
    const res = await POST(makeReq('issue-close', { number: 5, reason: 'rejected' }));
    expect(res.status).toBe(400);
  });

  it('passes --comment when supplied; omits it otherwise', async () => {
    await POST(makeReq('issue-close', { number: 7, reason: 'completed' }));
    let lastArgs = execMock.mock.calls[execMock.mock.calls.length - 1][1] as string[];
    expect(lastArgs).toEqual(['issue', 'close', '7', '--repo', 'owner/repo', '--reason', 'completed']);

    execMock.mockClear();
    await POST(makeReq('issue-close', { number: 8, reason: 'not planned', comment: 'stale' }));
    lastArgs = execMock.mock.calls[execMock.mock.calls.length - 1][1] as string[];
    expect(lastArgs).toEqual(['issue', 'close', '8', '--repo', 'owner/repo', '--reason', 'not planned', '--comment', 'stale']);
  });

  it('invalidates both detail and list caches on success', async () => {
    await seedDetailCache(sharedHandle, 'proj1', 5);
    await sharedHandle.db.insert(schema.ghIssuesCache).values({
      project: 'proj1', repo: 'owner/repo', prs: '[]', issues: '[]', fetchedAt: Date.now() / 1000,
    });

    const res = await POST(makeReq('issue-close', { number: 5, reason: 'completed' }));
    expect(res.status).toBe(200);

    expect(await sharedHandle.db.select().from(schema.ghIssueDetailCache)).toHaveLength(0);
    expect(await sharedHandle.db.select().from(schema.ghIssuesCache)).toHaveLength(0);
  });
});

describe('POST /issue-label', () => {
  async function POST(req: NextRequest, c = ctx()) {
    const mod = await import('@/app/api/projects/by-project/[projectName]/issue-label/route');
    return mod.POST(req, c);
  }

  it('returns 400 when neither addLabels nor removeLabels is provided', async () => {
    const res = await POST(makeReq('issue-label', { number: 5 }));
    expect(res.status).toBe(400);
  });

  it('drops invalid label names silently and 400s when nothing remains', async () => {
    const res = await POST(makeReq('issue-label', { number: 5, addLabels: ['$$$bad!!!'] }));
    expect(res.status).toBe(400);
  });

  it('creates label idempotently and runs gh issue edit', async () => {
    // First exec: gh label create succeeds (label was missing).
    // Second exec: gh issue edit succeeds.
    execMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const res = await POST(makeReq('issue-label', { number: 9, addLabels: ['needs-info'] }));
    expect(res.status).toBe(200);

    expect(execMock.mock.calls[0][0]).toBe('gh');
    expect(execMock.mock.calls[0][1]).toEqual(['label', 'create', 'needs-info', '--repo', 'owner/repo', '--color', 'FBCA04']);
    expect(execMock.mock.calls[1][1]).toEqual(['issue', 'edit', '9', '--repo', 'owner/repo', '--add-label', 'needs-info']);
  });

  it('swallows "already exists" from gh label create', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'label "needs-info" already exists' })
      .mockResolvedValueOnce(ok());

    const res = await POST(makeReq('issue-label', { number: 9, addLabels: ['needs-info'] }));
    expect(res.status).toBe(200);
  });

  it('handles remove-only without label create', async () => {
    execMock.mockResolvedValueOnce(ok());
    const res = await POST(makeReq('issue-label', { number: 9, removeLabels: ['blocked'] }));
    expect(res.status).toBe(200);
    expect(execMock.mock.calls[0][1]).toEqual(['issue', 'edit', '9', '--repo', 'owner/repo', '--remove-label', 'blocked']);
  });
});
