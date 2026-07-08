import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';
import { parseHealthVerdict } from '@/lib/agents/health-report';

describe('parseHealthVerdict', () => {
  it('parses each verdict + reason', () => {
    expect(parseHealthVerdict('...\nHEALTH_VERDICT: DOWN — 502 at /api/health')).toEqual({
      verdict: 'DOWN',
      reason: '502 at /api/health',
    });
    expect(parseHealthVerdict('HEALTH_VERDICT: HEALTHY — all green')!.verdict).toBe('HEALTHY');
    expect(parseHealthVerdict('HEALTH_VERDICT: degraded — slow')!.verdict).toBe('DEGRADED');
    expect(parseHealthVerdict('no verdict here')).toBeNull();
  });
});

describe('applyHealthVerdict', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestPgDb();
  });

  afterAll(async () => {
    await handle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await handle.db.execute(sql.raw('TRUNCATE recommendations RESTART IDENTITY CASCADE'));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
  });

  function healthJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'j1',
      project: 'demo',
      kind: 'agent:health',
      contextMeta: JSON.stringify({ agent: { id: 'a1', name: 'health', role: 'monitor' } }),
      workSummary: null,
      exitCode: 0,
      ...overrides,
    } as never;
  }

  it('DOWN persists the verdict on the job and opens an app_health rec', async () => {
    const { applyHealthVerdict } = await import('@/lib/agents/health-report');
    const job = healthJob();
    await applyHealthVerdict(job, 'HEALTH_VERDICT: DOWN — unreachable');
    expect(JSON.parse((job as { contextMeta: string }).contextMeta).healthVerdict.verdict).toBe('DOWN');
    const recs = await handle.db.select().from(schema.recommendations)
      .where(eq(schema.recommendations.project, 'demo'));
    expect(recs.some((r) => r.type === 'app_health' && r.status === 'open')).toBe(true);
  });

  it('unparseable report defaults to DEGRADED (never silent)', async () => {
    const { applyHealthVerdict } = await import('@/lib/agents/health-report');
    const job = healthJob();
    await applyHealthVerdict(job, 'the app looked fine but I forgot the verdict line');
    expect(JSON.parse((job as { contextMeta: string }).contextMeta).healthVerdict.verdict).toBe('DEGRADED');
  });

  it('HEALTHY resolves an open app_health rec', async () => {
    const { applyHealthVerdict } = await import('@/lib/agents/health-report');
    await applyHealthVerdict(healthJob(), 'HEALTH_VERDICT: DOWN — x');
    await applyHealthVerdict(healthJob({ id: 'j2' }), 'HEALTH_VERDICT: HEALTHY — recovered');
    const recs = await handle.db.select().from(schema.recommendations)
      .where(eq(schema.recommendations.project, 'demo'));
    const rec = recs.find((r) => r.type === 'app_health');
    expect(rec?.status).toBe('resolved');
  });
});
