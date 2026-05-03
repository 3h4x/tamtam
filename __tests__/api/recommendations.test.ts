import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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

describe('/api/projects/by-project/[projectName]/recommendations', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/recommendations/route').GET;
  let PATCH: typeof import('@/app/api/projects/by-project/[projectName]/recommendations/route').PATCH;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    ({ GET, PATCH } = await import('@/app/api/projects/by-project/[projectName]/recommendations/route'));
  });

  it('lists project recommendations newest first with parsed payload', async () => {
    testDb.db.insert(schema.recommendations).values({
      id: 'portal:agent_schedule_backoff:agent-1',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 200,
    }).run();

    const res = await GET(new NextRequest('http://test'), { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].payload.recommendedSchedule).toBe('8h');
  });

  it('updates recommendation status', async () => {
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-1',
      project: 'portal',
      sourceKind: 'agent:tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      createdAt: 100,
      updatedAt: 100,
    }).run();

    const req = new NextRequest('http://test', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'rec-1', status: 'dismissed' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation.status).toBe('dismissed');
  });

  it('rejects invalid status updates', async () => {
    const req = new NextRequest('http://test', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'rec-1', status: 'bad' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'portal' }) });
    expect(res.status).toBe(400);
  });
});
