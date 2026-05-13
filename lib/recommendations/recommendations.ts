import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

export type RecommendationStatus = 'open' | 'dismissed' | 'applied';

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

export async function upsertRecommendation(input: RecommendationInput): Promise<RecommendationRow | null> {
  const now = Date.now() / 1000;
  const idBase = [
    input.project,
    input.type,
    input.agentId || input.agentName || 'project',
  ].join(':');
  const id = idBase.replace(/[^a-zA-Z0-9:_-]+/g, '-');
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
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(eq(schema.recommendations.status, 'open'));
  const byProject: Record<string, number> = {};
  for (const row of rows) {
    byProject[row.project] = (byProject[row.project] ?? 0) + 1;
  }
  return { openCount: rows.length, byProject };
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
  const result = await db.update(schema.recommendations)
    .set({ status: nextStatus, updatedAt: now })
    .where(
      and(
        eq(schema.recommendations.project, project),
        eq(schema.recommendations.id, id),
        eq(schema.recommendations.status, currentStatus),
      ),
    )
    .execute();
  if (!result.rowCount) return null;
  return getRecommendation(project, id);
}
