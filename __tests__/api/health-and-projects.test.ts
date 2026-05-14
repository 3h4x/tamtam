import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const mocks = vi.hoisted(() => ({
  fetchProjectData: vi.fn(),
  dbRef: { current: null as unknown },
}));

vi.mock('@/lib/shared/project-data', () => ({
  fetchProjectData: mocks.fetchProjectData,
}));

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.dbRef.current;
  },
  schema,
}));

const { GET: HealthGET } = await import('@/app/api/health/route');
const { GET: ProjectsGET } = await import('@/app/api/projects/route');

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await HealthGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});

describe('GET /api/projects', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await sharedHandle.db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS gh_issues_cache (
        project text PRIMARY KEY,
        repo text NOT NULL,
        prs text NOT NULL DEFAULT '[]',
        issues text NOT NULL DEFAULT '[]',
        fetched_at double precision NOT NULL
      )
    `));
    mocks.dbRef.current = sharedHandle.db;
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('DELETE FROM gh_issues_cache'));
    mocks.fetchProjectData.mockReset();
    mocks.fetchProjectData.mockResolvedValue({
      projects: {},
      priorities: {},
    });
  });

  it('returns empty tasks and priorities when no projects', async () => {
    const res = await ProjectsGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
    expect(data.priorities).toEqual({});
  });

  it('returns tasks flattened from all projects', async () => {
    mocks.fetchProjectData.mockResolvedValue({
      projects: {
        'proj-a': [
          { id: 'task-1', name: 'Task 1' },
          { id: 'task-2', name: 'Task 2' },
        ],
        'proj-b': [{ id: 'task-3', name: 'Task 3' }],
      },
      priorities: { 'proj-a': 'high', 'proj-b': 'low' },
    });

    const res = await ProjectsGET();
    const data = await res.json();
    expect(data.tasks).toHaveLength(3);
    expect(data.priorities['proj-a']).toBe('high');
  });

  it('injects project name into each task', async () => {
    mocks.fetchProjectData.mockResolvedValue({
      projects: {
        'my-proj': [{ id: 'task-1', kind: 'review' }],
      },
      priorities: {},
    });

    const res = await ProjectsGET();
    const data = await res.json();
    expect(data.tasks[0].project).toBe('my-proj');
  });

  it('handles multiple tasks per project', async () => {
    mocks.fetchProjectData.mockResolvedValue({
      projects: {
        'proj-x': [
          { id: 't1', kind: 'run' },
          { id: 't2', kind: 'review' },
          { id: 't3', kind: 'test' },
        ],
      },
      priorities: {},
    });

    const res = await ProjectsGET();
    const data = await res.json();
    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.every((t: any) => t.project === 'proj-x')).toBe(true);
  });

  it('calls fetchProjectData', async () => {
    await ProjectsGET();
    expect(mocks.fetchProjectData).toHaveBeenCalledOnce();
  });
});
