import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS initiatives (
      "id" serial PRIMARY KEY NOT NULL,
      "project" text NOT NULL,
      "source" text NOT NULL,
      "kind" text NOT NULL,
      "title" text NOT NULL,
      "rationale" text NOT NULL,
      "prompt" text NOT NULL,
      "score" double precision DEFAULT 0 NOT NULL,
      "status" text DEFAULT 'proposed' NOT NULL,
      "dedup_key" text NOT NULL,
      "release_id" text,
      "attempts" integer DEFAULT 0 NOT NULL,
      "cooldown_until" double precision,
      "pinned_at" double precision,
      "created_at" double precision NOT NULL,
      "updated_at" double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "initiatives_project_dedup_key"
      ON "initiatives" ("project", "dedup_key")
  `));
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

describe('GET /api/stats/orchestrator', () => {
  let sharedHandle: TestDbHandle;
  let GET: typeof import('@/app/api/stats/orchestrator/route').GET;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try { await sharedHandle[Symbol.asyncDispose](); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE initiatives RESTART IDENTITY'));
    await sharedHandle.db.execute(sql.raw('TRUNCATE recommendations'));
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings'));

    // Seed settings so getSettings() resolves flags without hitting real DB
    await sharedHandle.db.insert(schema.settings).values([
      { key: 'orchestrator_enabled', value: 'true' },
      { key: 'initiative_engine_enabled', value: 'true' },
      { key: 'initiative_mining_enabled', value: 'true' },
      { key: 'initiative_max_ships_per_day', value: '5' },
    ]);

    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    // config module reads from DB; mock getSettings to return deterministic flags
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        orchestrator_enabled: true,
        initiative_engine_enabled: true,
        initiative_mining_enabled: true,
        initiative_max_ships_per_day: 5,
      }),
      initSettings: vi.fn().mockResolvedValue(undefined),
    }));

    ({ GET } = await import('@/app/api/stats/orchestrator/route'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 200 with expected shape when tables are empty', async () => {
    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.generatedAt).toBe('number');
    expect(body.flags.orchestratorEnabled).toBe(true);
    expect(body.flags.maxShipsPerDay).toBe(5);
    expect(body.initiatives.counts.proposed).toBe(0);
    expect(body.initiatives.shippedToday).toBe(0);
    expect(body.initiatives.recent).toEqual([]);
    expect(body.actions.last24h.boosts).toBe(0);
    expect(body.actions.last24h.autopilot).toBe(0);
    expect(body.actions.last24h.healthConcerns).toBe(0);
    expect(body.actions.recent).toEqual([]);
  });

  it('counts initiative statuses correctly', async () => {
    const nowMs = Date.now();
    await sharedHandle.db.insert(schema.initiatives).values([
      { project: 'alpha', source: 'mining', kind: 'lint', title: 'T1', rationale: 'r', prompt: 'p', dedupKey: 'k1', status: 'proposed', createdAt: nowMs, updatedAt: nowMs },
      { project: 'alpha', source: 'mining', kind: 'lint', title: 'T2', rationale: 'r', prompt: 'p', dedupKey: 'k2', status: 'shipped', createdAt: nowMs, updatedAt: nowMs },
      { project: 'beta', source: 'pm', kind: 'feat', title: 'T3', rationale: 'r', prompt: 'p', dedupKey: 'k3', status: 'failed', createdAt: nowMs, updatedAt: nowMs },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    const body = await res.json();
    expect(body.initiatives.counts.proposed).toBe(1);
    expect(body.initiatives.counts.shipped).toBe(1);
    expect(body.initiatives.counts.failed).toBe(1);
    expect(body.initiatives.counts.queued).toBe(0);
    expect(body.initiatives.counts.running).toBe(0);
  });

  it('shippedToday counts only shipped rows updated today', async () => {
    const nowMs = Date.now();
    const startOfDay = Math.floor(nowMs / 86_400_000) * 86_400_000;

    await sharedHandle.db.insert(schema.initiatives).values([
      // shipped today
      { project: 'x', source: 'mining', kind: 'k', title: 'T', rationale: 'r', prompt: 'p', dedupKey: 'today', status: 'shipped', createdAt: startOfDay + 100, updatedAt: startOfDay + 100 },
      // shipped yesterday
      { project: 'x', source: 'mining', kind: 'k', title: 'T', rationale: 'r', prompt: 'p', dedupKey: 'yest', status: 'shipped', createdAt: startOfDay - 1000, updatedAt: startOfDay - 1000 },
      // proposed today — not counted
      { project: 'x', source: 'mining', kind: 'k', title: 'T', rationale: 'r', prompt: 'p', dedupKey: 'prop', status: 'proposed', createdAt: startOfDay + 200, updatedAt: startOfDay + 200 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    const body = await res.json();
    expect(body.initiatives.shippedToday).toBeGreaterThanOrEqual(1);
  });

  it('recent initiatives are populated and ordered updatedAt desc', async () => {
    const nowMs = Date.now();
    await sharedHandle.db.insert(schema.initiatives).values([
      { project: 'p1', source: 'mining', kind: 'lint', title: 'Oldest', rationale: 'r', prompt: 'p', dedupKey: 'old', status: 'proposed', createdAt: nowMs - 3000, updatedAt: nowMs - 3000 },
      { project: 'p1', source: 'pm', kind: 'feat', title: 'Newest', rationale: 'r', prompt: 'p', dedupKey: 'new', status: 'queued', createdAt: nowMs - 1000, updatedAt: nowMs - 1000 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    const body = await res.json();
    expect(body.initiatives.recent).toHaveLength(2);
    expect(body.initiatives.recent[0].project).toBe('p1');
    // newest first
    expect(body.initiatives.recent[0].updatedAt).toBeGreaterThan(body.initiatives.recent[1].updatedAt);
    // shape check
    const r = body.initiatives.recent[0];
    expect(typeof r.kind).toBe('string');
    expect(typeof r.status).toBe('string');
    expect(typeof r.source).toBe('string');
    expect(typeof r.score).toBe('number');
  });

  it('actions.last24h categorizes orchestrator recommendation types', async () => {
    // recommendations use epoch-seconds for updated_at
    const nowSec = Date.now() / 1000;
    const recentSec = nowSec - 3600; // 1h ago = within 24h

    await sharedHandle.db.insert(schema.recommendations).values([
      { id: 'boost-1', project: 'p', sourceKind: 'orchestrator', type: 'orchestrator_boost', title: 'Boost', detail: 'd', status: 'resolved', createdAt: recentSec, updatedAt: recentSec },
      { id: 'auto-1', project: 'p', sourceKind: 'orchestrator', type: 'agent_autopilot', title: 'Auto', detail: 'd', status: 'open', createdAt: recentSec, updatedAt: recentSec },
      { id: 'health-1', project: 'p', sourceKind: 'orchestrator', type: 'orchestrator_agent_health', title: 'Health', detail: 'd', status: 'open', createdAt: recentSec, updatedAt: recentSec },
      // Non-orchestrator type — should not be counted
      { id: 'other-1', project: 'p', sourceKind: 'agent:x', type: 'agent_unfruitful', title: 'Other', detail: 'd', status: 'open', createdAt: recentSec, updatedAt: recentSec },
      // Old orchestrator_boost (older than 24h) — not counted in last24h
      { id: 'boost-old', project: 'p', sourceKind: 'orchestrator', type: 'orchestrator_boost', title: 'OldBoost', detail: 'd', status: 'resolved', createdAt: nowSec - 90000, updatedAt: nowSec - 90000 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    const body = await res.json();
    expect(body.actions.last24h.boosts).toBe(1);
    expect(body.actions.last24h.autopilot).toBe(1);
    expect(body.actions.last24h.healthConcerns).toBe(1);
  });

  it('actions.recent contains only orchestrator-type rows ordered updatedAt desc', async () => {
    const nowSec = Date.now() / 1000;

    await sharedHandle.db.insert(schema.recommendations).values([
      { id: 'boost-a', project: 'pa', sourceKind: 'orchestrator', type: 'orchestrator_boost', title: 'Old boost', detail: 'd', status: 'resolved', agentName: 'agent-x', createdAt: nowSec - 200, updatedAt: nowSec - 200 },
      { id: 'boost-b', project: 'pb', sourceKind: 'orchestrator', type: 'orchestrator_boost', title: 'New boost', detail: 'd', status: 'resolved', agentName: null, createdAt: nowSec - 100, updatedAt: nowSec - 100 },
      { id: 'unfruitful-1', project: 'pb', sourceKind: 'agent:x', type: 'agent_unfruitful', title: 'Skip me', detail: 'd', status: 'open', createdAt: nowSec - 50, updatedAt: nowSec - 50 },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/stats/orchestrator'));
    const body = await res.json();
    // only orchestrator types
    expect(body.actions.recent.every((r: { type: string }) =>
      ['orchestrator_boost', 'agent_autopilot', 'orchestrator_agent_health'].includes(r.type)
    )).toBe(true);
    // ordered newest first
    expect(body.actions.recent).toHaveLength(2);
    expect(body.actions.recent[0].title).toBe('New boost');
    expect(body.actions.recent[1].title).toBe('Old boost');
    // shape check
    const r = body.actions.recent[0];
    expect(r.project).toBe('pb');
    expect(r.agentName).toBeNull();
    expect(typeof r.updatedAt).toBe('number');
    expect(typeof r.status).toBe('string');
  });
});
