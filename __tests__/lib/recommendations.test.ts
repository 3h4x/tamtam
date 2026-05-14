import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
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

describe('recommendations storage', () => {
  let sharedHandle: TestDbHandle;
  // Back-compat shim so existing test bodies that use `handle.db` keep working.
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let upsertRecommendation: typeof import('@/lib/recommendations/recommendations').upsertRecommendation;
  let listRecommendations: typeof import('@/lib/recommendations/recommendations').listRecommendations;
  let updateRecommendationStatus: typeof import('@/lib/recommendations/recommendations').updateRecommendationStatus;

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

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE recommendations'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    ({ upsertRecommendation, listRecommendations, updateRecommendationStatus } = await import('@/lib/recommendations/recommendations'));
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('upserts a recommendation with a stable sanitized id and parsed payload', async () => {
    const row = await upsertRecommendation({
      project: 'owner/repo name',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentName: 'tests runner',
      type: 'agent_schedule_backoff',
      title: 'Run less often',
      detail: 'No actionable work found.',
      payload: { currentSchedule: '2h', recommendedSchedule: '8h' },
    });

    expect(row).toMatchObject({
      id: 'owner-repo-name:agent_schedule_backoff:tests-runner',
      source_kind: 'agent:tests',
      source_id: 'job-1',
      agent_name: 'tests runner',
      status: 'open',
      payload: { currentSchedule: '2h', recommendedSchedule: '8h' },
    });
  });

  it('updates an existing recommendation, reopens it, and preserves created_at ordering fields', async () => {
    const first = await upsertRecommendation({
      project: 'portal',
      sourceKind: 'agent:tests',
      agentId: 'agent-1',
      type: 'agent_schedule_backoff',
      title: 'Old title',
      detail: 'Old detail',
      payload: { recommendedSchedule: '4h' },
    });

    const updated = await updateRecommendationStatus('portal', first!.id, 'dismissed');
    expect(updated?.status).toBe('dismissed');

    const second = await upsertRecommendation({
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-2',
      agentId: 'agent-1',
      type: 'agent_schedule_backoff',
      title: 'New title',
      detail: 'New detail',
      payload: { recommendedSchedule: '8h' },
    });

    expect(second).toMatchObject({
      id: first!.id,
      source_id: 'job-2',
      title: 'New title',
      detail: 'New detail',
      status: 'open',
      payload: { recommendedSchedule: '8h' },
    });
    expect(second!.created_at).toBe(first!.created_at);
    expect(second!.updated_at).toBeGreaterThanOrEqual(first!.updated_at);
  });

  it('lists newest recommendations first and drops invalid JSON payloads to null', async () => {
    await handle.db.insert(schema.recommendations).values([
      {
        id: 'rec-older',
        project: 'portal',
        sourceKind: 'agent:tests',
        type: 'agent_schedule_backoff',
        title: 'Older',
        detail: 'Older detail',
        status: 'open',
        payload: '{bad json',
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: 'rec-newer',
        project: 'portal',
        sourceKind: 'agent:tests',
        type: 'agent_schedule_backoff',
        title: 'Newer',
        detail: 'Newer detail',
        status: 'open',
        payload: JSON.stringify({ recommendedSchedule: '12h' }),
        createdAt: 11,
        updatedAt: 30,
      },
    ]);

    const rows = await listRecommendations('portal');

    expect(rows.map((row) => row.id)).toEqual(['rec-newer', 'rec-older']);
    expect(rows[0].payload).toEqual({ recommendedSchedule: '12h' });
    expect(rows[1].payload).toBeNull();
  });

  it('returns null when updating a missing recommendation', async () => {
    expect(await updateRecommendationStatus('portal', 'missing', 'applied')).toBeNull();
  });
});
