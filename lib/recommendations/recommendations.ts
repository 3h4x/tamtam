import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

// `resolved` is a terminal status set automatically by the detectors when the
// condition that produced a recommendation no longer holds (e.g. an unfruitful
// agent starts producing again). It's distinct from the operator-driven
// `dismissed` / `applied` so auto-retirement never masks a human decision.
export type RecommendationStatus = 'open' | 'dismissed' | 'applied' | 'resolved';

export interface RecommendationPayload {
  [key: string]: unknown;
}

export interface RecommendationInput {
  project: string;
  sourceKind: string;
  sourceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  type: string;
  title: string;
  detail: string;
  payload?: RecommendationPayload | null;
}

export interface RecommendationRow {
  id: string;
  project: string;
  source_kind: string;
  source_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  type: string;
  title: string;
  detail: string;
  status: RecommendationStatus;
  payload: RecommendationPayload | null;
  created_at: number;
  updated_at: number;
}

function rowToDict(row: typeof schema.recommendations.$inferSelect): RecommendationRow {
  let payload: RecommendationPayload | null = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as RecommendationPayload;
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    project: row.project,
    source_kind: row.sourceKind,
    source_id: row.sourceId ?? null,
    agent_id: row.agentId ?? null,
    agent_name: row.agentName ?? null,
    type: row.type,
    title: row.title,
    detail: row.detail,
    status: row.status as RecommendationStatus,
    payload,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// Deterministic id for a recommendation. The same (project, type, agent) always
// maps to the same row so re-detection upserts in place — and so the recovery
// resolver can address the exact row without a lookup. `agentKey` must be the
// already-resolved `agentId || agentName || 'project'` used at creation time.
export function recommendationId(project: string, type: string, agentKey: string): string {
  return [project, type, agentKey].join(':').replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

export async function upsertRecommendation(input: RecommendationInput): Promise<RecommendationRow | null> {
  const now = Date.now() / 1000;
  const id = recommendationId(input.project, input.type, input.agentId || input.agentName || 'project');
  try {
    await db.insert(schema.recommendations)
      .values({
        id,
        project: input.project,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        agentId: input.agentId ?? null,
        agentName: input.agentName ?? null,
        type: input.type,
        title: input.title,
        detail: input.detail,
        status: 'open',
        payload: input.payload ? JSON.stringify(input.payload) : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.recommendations.id,
        set: {
          sourceKind: input.sourceKind,
          sourceId: input.sourceId ?? null,
          title: input.title,
          detail: input.detail,
          status: 'open',
          payload: input.payload ? JSON.stringify(input.payload) : null,
          updatedAt: now,
        },
      })
      .execute();
    const rows = await db.select().from(schema.recommendations).where(eq(schema.recommendations.id, id)).limit(1);
    return rows[0] ? rowToDict(rows[0]) : null;
  } catch (e) {
    console.error('[recommendations] failed to upsert recommendation:', e);
    return null;
  }
}

export async function listRecommendations(project: string): Promise<RecommendationRow[]> {
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(eq(schema.recommendations.project, project))
    .orderBy(desc(schema.recommendations.updatedAt));
  return rows.map(rowToDict);
}

export async function getRecommendation(project: string, id: string): Promise<RecommendationRow | null> {
  const rows = await db.select().from(schema.recommendations)
    .where(and(eq(schema.recommendations.project, project), eq(schema.recommendations.id, id)))
    .limit(1);
  return rows[0] ? rowToDict(rows[0]) : null;
}

/**
 * Summary of open recommendations across every project. Used by the global
 * header chip + the cross-project recommendations page. Returns a sorted
 * `byProject` map (descending count) so the heaviest projects surface first.
 */
export async function summarizeOpenRecommendations(): Promise<{ openCount: number; byProject: Record<string, number> }> {
  // GROUP BY pushes counting to the DB instead of fetching every column of
  // every open recommendation just to count them in JS. With a large
  // backlog the prior `SELECT * + count-in-loop` form transferred
  // ~hundreds of bytes per row across the wire on every poll of the
  // global header chip; this form returns one row per project.
  const rows = await db
    .select({
      project: schema.recommendations.project,
      count: sql<number>`count(*)`,
    })
    .from(schema.recommendations)
    .where(eq(schema.recommendations.status, 'open'))
    .groupBy(schema.recommendations.project);
  const byProject: Record<string, number> = {};
  let openCount = 0;
  for (const row of rows) {
    const c = Number(row.count);
    byProject[row.project] = c;
    openCount += c;
  }
  return { openCount, byProject };
}

/**
 * List every open recommendation across all projects, newest-first. Powers
 * the global `/recommendations` page so operators can triage from one
 * location instead of project-hopping.
 */
export async function listAllOpenRecommendations(): Promise<RecommendationRow[]> {
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(eq(schema.recommendations.status, 'open'))
    .orderBy(desc(schema.recommendations.updatedAt));
  return rows.map(rowToDict);
}

/**
 * Every non-open recommendation across all projects, newest-first — the
 * "History" tab. Includes orchestrator `resolved` rows plus operator
 * `dismissed` / `applied` rows so the operator can see what was done.
 */
export async function listAllResolvedRecommendations(): Promise<RecommendationRow[]> {
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(sql`${schema.recommendations.status} <> 'open'`)
    .orderBy(desc(schema.recommendations.updatedAt));
  return rows.map(rowToDict);
}

export async function updateRecommendationStatus(project: string, id: string, status: RecommendationStatus): Promise<RecommendationRow | null> {
  const now = Date.now() / 1000;
  await db.update(schema.recommendations)
    .set({ status, updatedAt: now })
    .where(and(eq(schema.recommendations.project, project), eq(schema.recommendations.id, id)))
    .execute();
  return getRecommendation(project, id);
}

export async function updateRecommendationStatusIfCurrent(
  project: string,
  id: string,
  currentStatus: RecommendationStatus,
  nextStatus: RecommendationStatus,
): Promise<RecommendationRow | null> {
  const now = Date.now() / 1000;
  const updated = await db.update(schema.recommendations)
    .set({ status: nextStatus, updatedAt: now })
    .where(
      and(
        eq(schema.recommendations.project, project),
        eq(schema.recommendations.id, id),
        eq(schema.recommendations.status, currentStatus),
      ),
    )
    .returning({ id: schema.recommendations.id });
  if (updated.length === 0) return null;
  return getRecommendation(project, id);
}

/**
 * Auto-retire a recommendation whose triggering condition no longer holds.
 * Flips `open → resolved` for the deterministic (project, type, agent) row and
 * is a no-op when no open row exists or it was already `dismissed`/`applied`
 * (so it never overrides an operator's decision). Detectors call this on the
 * recovery branch where they used to just `return`.
 */
export async function resolveRecommendationIfOpen(
  project: string,
  type: string,
  agent: { agentId?: string | null; agentName?: string | null },
): Promise<RecommendationRow | null> {
  const id = recommendationId(project, type, agent.agentId || agent.agentName || 'project');
  return updateRecommendationStatusIfCurrent(project, id, 'open', 'resolved');
}
