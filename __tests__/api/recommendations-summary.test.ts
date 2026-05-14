import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id text PRIMARY KEY,
      project text NOT NULL,
      source_kind text NOT NULL,
      source_id text,
      agent_id text,
      agent_name text,
      type text NOT NULL,
      title text NOT NULL,
      detail text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      payload text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

async function seed(project: string, status: string, idSuffix = ''): Promise<void> {
  await sharedHandle.db.insert(schema.recommendations).values({
    id: `${project}:rec${idSuffix}`,
    project,
    sourceKind: 'agent:tests',
    sourceId: 'job-1',
    agentId: 'agent-1',
    agentName: 'tests',
    type: 'agent_schedule_backoff',
    title: 'Run tests less often',
    detail: 'No actionable work.',
    status,
    payload: JSON.stringify({ recommendedSchedule: '8h' }),
    createdAt: 100,
    updatedAt: 200,
  });
}

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 30));
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

describe('GET /api/recommendations/summary', () => {
  let GET: typeof import('@/app/api/recommendations/summary/route').GET;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE recommendations'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    ({ GET } = await import('@/app/api/recommendations/summary/route'));
  });

  it('returns zero counts when no recommendations exist', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual({ openCount: 0, byProject: {} });
  });

  it('counts only `open` rows, ignoring dismissed and applied', async () => {
    await seed('portal', 'open', 'a');
    await seed('portal', 'open', 'b');
    await seed('portal', 'dismissed', 'c');
    await seed('portal', 'applied', 'd');
    await seed('tamtam', 'open', 'e');

    const res = await GET();
    const data = await res.json();
    expect(data.openCount).toBe(3);
    expect(data.byProject).toEqual({ portal: 2, tamtam: 1 });
  });
});

describe('GET /api/recommendations (cross-project list)', () => {
  let GET: typeof import('@/app/api/recommendations/route').GET;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE recommendations'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    ({ GET } = await import('@/app/api/recommendations/route'));
  });

  it('returns only open recommendations, with parsed payload', async () => {
    await seed('portal', 'open', 'a');
    await seed('portal', 'dismissed', 'b');
    await seed('tamtam', 'open', 'c');

    const res = await GET();
    const data = await res.json();
    expect(data.recommendations).toHaveLength(2);
    for (const r of data.recommendations) {
      expect(r.status).toBe('open');
      expect(r.payload.recommendedSchedule).toBe('8h');
    }
  });
});
