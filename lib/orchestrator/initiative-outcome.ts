import { and, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import * as store from '@/lib/orchestrator/initiatives-store';

const FAILURE_COOLDOWN_MS = 6 * 3600 * 1000;

export async function markInitiativeOutcome(
  id: number,
  outcome: 'shipped' | 'failed',
  releaseId: string | null,
  nowMs: number = Date.now(),
): Promise<void> {
  if (outcome === 'shipped') {
    await store.setStatus(id, 'shipped', { releaseId, cooldownUntil: null }, nowMs);
  } else {
    await store.setStatus(id, 'failed', { releaseId, cooldownUntil: nowMs + FAILURE_COOLDOWN_MS }, nowMs);
  }
}

export async function shipsTodayCount(project: string, nowMs: number = Date.now()): Promise<number> {
  const rows = await db.select().from(schema.initiatives).where(and(
    eq(schema.initiatives.project, project),
    eq(schema.initiatives.status, 'shipped'),
    gte(schema.initiatives.updatedAt, store.startOfUtcDay(nowMs)),
  ));
  return rows.length;
}
