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
  let resolveRecommendationIfOpen: typeof import('@/lib/recommendations/recommendations').resolveRecommendationIfOpen;
  let resolveOpenRecommendationsForAgents: typeof import('@/lib/recommendations/recommendations').resolveOpenRecommendationsForAgents;
  let recommendationId: typeof import('@/lib/recommendations/recommendations').recommendationId;
  let listAllOpenRecommendations: typeof import('@/lib/recommendations/recommendations').listAllOpenRecommendations;
  let listAllResolvedRecommendations: typeof import('@/lib/recommendations/recommendations').listAllResolvedRecommendations;

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
    ({ upsertRecommendation, listRecommendations, updateRecommendationStatus, resolveRecommendationIfOpen, resolveOpenRecommendationsForAgents, recommendationId, listAllOpenRecommendations, listAllResolvedRecommendations } = await import('@/lib/recommendations/recommendations'));
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

  it('creates an AUTO recommendation pre-resolved so it lands in History, not Unresolved', async () => {
    const created = await upsertRecommendation({
      project: 'portal',
      sourceKind: 'orchestrator',
      agentId: 'agent-boost',
      type: 'orchestrator_boost',
      title: 'Boosted improve',
      detail: 'Queued an extra run.',
      status: 'resolved',
    });
    expect(created?.status).toBe('resolved');

    // It must not appear in the Unresolved queue...
    expect((await listAllOpenRecommendations()).map((r) => r.id)).not.toContain(created!.id);
    // ...but it is inspectable in History.
    expect((await listAllResolvedRecommendations()).map((r) => r.id)).toContain(created!.id);

    // Re-boosting the same agent keeps the row archived (no reopen to Unresolved).
    const reboost = await upsertRecommendation({
      project: 'portal',
      sourceKind: 'orchestrator',
      agentId: 'agent-boost',
      type: 'orchestrator_boost',
      title: 'Boosted improve in smart mode',
      detail: 'Queued another extra run.',
      status: 'resolved',
    });
    expect(reboost!.id).toBe(created!.id);
    expect(reboost!.status).toBe('resolved');
    expect((await listAllOpenRecommendations()).map((r) => r.id)).not.toContain(created!.id);
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

  it('splits open (Unresolved) from non-open (History) across projects', async () => {
    const base = (over: { id: string; status: string; updatedAt: number }) => ({
      id: over.id, project: 'portal', sourceKind: 'agent:x', type: 'agent_unfruitful',
      title: over.id, detail: 'd', status: over.status, createdAt: 1, updatedAt: over.updatedAt,
    });
    await handle.db.insert(schema.recommendations).values([
      base({ id: 'open-1', status: 'open', updatedAt: 50 }),
      base({ id: 'resolved-1', status: 'resolved', updatedAt: 70 }),
      base({ id: 'dismissed-1', status: 'dismissed', updatedAt: 60 }),
      base({ id: 'applied-1', status: 'applied', updatedAt: 80 }),
    ]);

    const open = await listAllOpenRecommendations();
    expect(open.map((r) => r.id)).toEqual(['open-1']);

    // History = everything not open, newest-first.
    const history = await listAllResolvedRecommendations();
    expect(history.map((r) => r.id)).toEqual(['applied-1', 'resolved-1', 'dismissed-1']);
    expect(history.map((r) => r.status)).toEqual(['applied', 'resolved', 'dismissed']);
  });

  it('auto-resolves an open recommendation when the condition clears', async () => {
    const created = await upsertRecommendation({
      project: 'portal',
      sourceKind: 'agent:audit',
      agentId: 'agent-7',
      agentName: 'audit',
      type: 'agent_unfruitful',
      title: "audit isn't producing changes",
      detail: 'No changes.',
    });
    // Resolver must address the same deterministic id upsert created.
    expect(created!.id).toBe(recommendationId('portal', 'agent_unfruitful', 'agent-7'));

    const resolved = await resolveRecommendationIfOpen('portal', 'agent_unfruitful', { agentId: 'agent-7', agentName: 'audit' });
    expect(resolved?.status).toBe('resolved');

    // Resolved rows drop off the open list.
    expect((await listRecommendations('portal')).filter((r) => r.status === 'open')).toHaveLength(0);
  });

  it('falls back to agent name then "project" when resolving by key', async () => {
    await upsertRecommendation({
      project: 'portal', sourceKind: 'agent:x', agentName: 'namedonly',
      type: 'agent_unfruitful', title: 't', detail: 'd',
    });
    const resolved = await resolveRecommendationIfOpen('portal', 'agent_unfruitful', { agentId: null, agentName: 'namedonly' });
    expect(resolved?.status).toBe('resolved');
  });

  it('does not override an operator decision or invent a row', async () => {
    // No open row → no-op.
    expect(await resolveRecommendationIfOpen('portal', 'agent_unfruitful', { agentId: 'ghost' })).toBeNull();

    // Already dismissed by the operator → resolver leaves it dismissed.
    const created = await upsertRecommendation({
      project: 'portal', sourceKind: 'agent:audit', agentId: 'agent-9', agentName: 'audit',
      type: 'agent_unfruitful', title: 't', detail: 'd',
    });
    await updateRecommendationStatus('portal', created!.id, 'dismissed');
    expect(await resolveRecommendationIfOpen('portal', 'agent_unfruitful', { agentId: 'agent-9' })).toBeNull();
    const rows = await listRecommendations('portal');
    expect(rows.find((r) => r.id === created!.id)?.status).toBe('dismissed');
  });

  it('bulk-resolves open recs of a type for a set of agents, leaving other agents, types, and operator decisions untouched', async () => {
    const mk = (agentId: string, type: string, status?: 'open' | 'dismissed') =>
      upsertRecommendation({
        project: 'p', sourceKind: 'orchestrator', agentId, agentName: agentId,
        type, title: 't', detail: 'd', ...(status ? { status } : {}),
      });
    await mk('a1', 'agent_unfruitful');
    await mk('a2', 'agent_unfruitful');
    await mk('a3', 'agent_unfruitful'); // disabled agent NOT in the reconcile set
    await mk('a4', 'agent_unfruitful', 'dismissed'); // operator decision — must survive
    await mk('a1', 'agent_schedule_backoff'); // different type — must survive

    const n = await resolveOpenRecommendationsForAgents('agent_unfruitful', ['a1', 'a2', 'a4']);
    expect(n).toBe(2); // a1 + a2 flipped; a4 was dismissed (skipped)

    const open = (await listAllOpenRecommendations()).map((r) => r.id);
    expect(open).not.toContain(recommendationId('p', 'agent_unfruitful', 'a1'));
    expect(open).not.toContain(recommendationId('p', 'agent_unfruitful', 'a2'));
    expect(open).toContain(recommendationId('p', 'agent_unfruitful', 'a3'));
    expect(open).toContain(recommendationId('p', 'agent_schedule_backoff', 'a1'));

    // Empty set is a no-op.
    expect(await resolveOpenRecommendationsForAgents('agent_unfruitful', [])).toBe(0);
  });
});
