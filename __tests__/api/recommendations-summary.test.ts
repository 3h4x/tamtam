import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      payload TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function seed(testDb: ReturnType<typeof createTestDb>, project: string, status: string, idSuffix = '') {
  testDb.db.insert(schema.recommendations).values({
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
  }).run();
}

describe('GET /api/recommendations/summary', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: typeof import('@/app/api/recommendations/summary/route').GET;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    ({ GET } = await import('@/app/api/recommendations/summary/route'));
  });

  it('returns zero counts when no recommendations exist', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual({ openCount: 0, byProject: {} });
  });

  it('counts only `open` rows, ignoring dismissed and applied', async () => {
    seed(testDb, 'portal', 'open', 'a');
    seed(testDb, 'portal', 'open', 'b');
    seed(testDb, 'portal', 'dismissed', 'c');
    seed(testDb, 'portal', 'applied', 'd');
    seed(testDb, 'tamtam', 'open', 'e');

    const res = await GET();
    const data = await res.json();
    expect(data.openCount).toBe(3);
    expect(data.byProject).toEqual({ portal: 2, tamtam: 1 });
  });
});

describe('GET /api/recommendations (cross-project list)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: typeof import('@/app/api/recommendations/route').GET;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    ({ GET } = await import('@/app/api/recommendations/route'));
  });

  it('returns only open recommendations, with parsed payload', async () => {
    seed(testDb, 'portal', 'open', 'a');
    seed(testDb, 'portal', 'dismissed', 'b');
    seed(testDb, 'tamtam', 'open', 'c');

    const res = await GET();
    const data = await res.json();
    expect(data.recommendations).toHaveLength(2);
    for (const r of data.recommendations) {
      expect(r.status).toBe('open');
      expect(r.payload.recommendedSchedule).toBe('8h');
    }
  });
});
