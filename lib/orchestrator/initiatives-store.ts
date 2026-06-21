import { and, eq, desc, or, isNull, lte, count, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

export type InitiativeSource = 'mining' | 'pm';
export type InitiativeStatus =
  | 'proposed' | 'queued' | 'running' | 'shipped' | 'failed' | 'rejected' | 'superseded';

export interface InitiativeCandidate {
  project: string; source: InitiativeSource; kind: string;
  title: string; rationale: string; prompt: string; dedupKey: string; score?: number;
}

export interface InitiativeRow {
  id: number; project: string; source: InitiativeSource; kind: string;
  title: string; rationale: string; prompt: string; score: number;
  status: InitiativeStatus; dedupKey: string; releaseId: string | null;
  attempts: number; cooldownUntil: number | null; pinnedAt: number | null; createdAt: number; updatedAt: number;
}

// Statuses whose copy may be refreshed by re-detection. Closed/in-flight rows
// are never downgraded by a fresh probe.
const REFRESHABLE: InitiativeStatus[] = ['proposed', 'queued'];

/** Floor a millisecond timestamp to the start of its UTC day. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

function toRow(r: typeof schema.initiatives.$inferSelect): InitiativeRow {
  return {
    id: r.id,
    project: r.project,
    source: r.source as InitiativeSource,
    kind: r.kind,
    title: r.title,
    rationale: r.rationale,
    prompt: r.prompt,
    score: r.score,
    status: r.status as InitiativeStatus,
    dedupKey: r.dedupKey,
    releaseId: r.releaseId,
    attempts: r.attempts,
    cooldownUntil: r.cooldownUntil,
    pinnedAt: r.pinnedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function upsertCandidate(c: InitiativeCandidate, nowMs: number = Date.now()): Promise<InitiativeRow> {
  const existing = (await db.select().from(schema.initiatives)
    .where(and(eq(schema.initiatives.project, c.project), eq(schema.initiatives.dedupKey, c.dedupKey)))
    .limit(1))[0];

  if (!existing) {
    const inserted = (await db.insert(schema.initiatives).values({
      project: c.project,
      source: c.source,
      kind: c.kind,
      title: c.title,
      rationale: c.rationale,
      prompt: c.prompt,
      score: c.score ?? 0,
      dedupKey: c.dedupKey,
      createdAt: nowMs,
      updatedAt: nowMs,
    }).returning())[0];
    return toRow(inserted);
  }

  if (!REFRESHABLE.includes(existing.status as InitiativeStatus)) {
    return toRow(existing); // closed/in-flight — leave untouched
  }

  const updated = (await db.update(schema.initiatives).set({
    title: c.title,
    rationale: c.rationale,
    prompt: c.prompt,
    score: c.score ?? existing.score,
    updatedAt: nowMs,
  }).where(eq(schema.initiatives.id, existing.id)).returning())[0];
  return toRow(updated);
}

export async function listByStatus(project: string, status: InitiativeStatus): Promise<InitiativeRow[]> {
  const rows = await db.select().from(schema.initiatives)
    .where(and(eq(schema.initiatives.project, project), eq(schema.initiatives.status, status)));
  return rows.map(toRow);
}

export async function listQueued(project: string, nowMs: number = Date.now()): Promise<InitiativeRow[]> {
  const rows = await db.select().from(schema.initiatives)
    .where(and(
      eq(schema.initiatives.project, project),
      eq(schema.initiatives.status, 'queued'),
      or(isNull(schema.initiatives.cooldownUntil), lte(schema.initiatives.cooldownUntil, nowMs)),
    ))
    .orderBy(sql`${schema.initiatives.pinnedAt} is null`, desc(schema.initiatives.score));
  return rows.map(toRow);
}

export async function setStatus(
  id: number,
  status: InitiativeStatus,
  patch: { releaseId?: string | null; cooldownUntil?: number | null; bumpAttempts?: boolean } = {},
  nowMs: number = Date.now(),
): Promise<void> {
  const set: Partial<typeof schema.initiatives.$inferInsert> = { status, updatedAt: nowMs };
  if ('releaseId' in patch) set.releaseId = patch.releaseId ?? null;
  if ('cooldownUntil' in patch) set.cooldownUntil = patch.cooldownUntil ?? null;
  if (patch.bumpAttempts) set.attempts = sql`${schema.initiatives.attempts} + 1` as unknown as number;
  await db.update(schema.initiatives).set(set).where(eq(schema.initiatives.id, id));
}

export async function linkRunningInitiativeToRelease(
  agentJobId: string,
  releaseJobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(schema.initiatives)
    .set({ releaseId: releaseJobId, updatedAt: nowMs })
    .where(and(
      eq(schema.initiatives.status, 'running'),
      eq(schema.initiatives.releaseId, agentJobId),
    ));
}

/** Set (promote) or clear (un-pin) an initiative's pin. Does not change status. */
export async function setPinned(id: number, pinnedMs: number | null, nowMs: number = Date.now()): Promise<void> {
  await db.update(schema.initiatives)
    .set({ pinnedAt: pinnedMs, updatedAt: nowMs })
    .where(eq(schema.initiatives.id, id));
}

/** Fetch a single initiative by id, or null if it does not exist. */
export async function getInitiativeById(id: number): Promise<InitiativeRow | null> {
  const row = (await db.select().from(schema.initiatives)
    .where(eq(schema.initiatives.id, id)).limit(1))[0];
  return row ? toRow(row) : null;
}

const ALL_STATUSES: InitiativeStatus[] = [
  'proposed', 'queued', 'running', 'shipped', 'failed', 'rejected', 'superseded',
];

/** Count all initiatives across all projects, grouped by status. Every InitiativeStatus key is present (zero-defaulted). */
export async function countByStatusAllProjects(): Promise<Record<InitiativeStatus, number>> {
  const rows = await db
    .select({ status: schema.initiatives.status, n: count() })
    .from(schema.initiatives)
    .groupBy(schema.initiatives.status);
  const result = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<InitiativeStatus, number>;
  for (const row of rows) {
    const s = row.status as InitiativeStatus;
    if (s in result) result[s] = Number(row.n);
  }
  return result;
}

/** Count shipped initiatives across all projects where updatedAt >= start-of-UTC-day(nowMs). */
export async function countShippedTodayAllProjects(nowMs: number = Date.now()): Promise<number> {
  const startOfDay = startOfUtcDay(nowMs);
  const rows = await db
    .select({ n: count() })
    .from(schema.initiatives)
    .where(and(
      eq(schema.initiatives.status, 'shipped'),
      gte(schema.initiatives.updatedAt, startOfDay),
    ));
  return Number(rows[0]?.n ?? 0);
}

/** Most-recently-updated initiatives across all projects, ordered updatedAt desc. */
export async function listRecentInitiatives(limit: number): Promise<InitiativeRow[]> {
  const rows = await db
    .select()
    .from(schema.initiatives)
    .orderBy(desc(schema.initiatives.updatedAt))
    .limit(limit);
  return rows.map(toRow);
}

/** All initiatives across all projects, ordered updatedAt desc, limited. */
export async function listAllInitiatives(limit: number): Promise<InitiativeRow[]> {
  const rows = await db
    .select()
    .from(schema.initiatives)
    .orderBy(desc(schema.initiatives.updatedAt))
    .limit(limit);
  return rows.map(toRow);
}
