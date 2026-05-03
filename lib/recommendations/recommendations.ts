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

export function upsertRecommendation(input: RecommendationInput): RecommendationRow | null {
  const now = Date.now() / 1000;
  const idBase = [
    input.project,
    input.type,
    input.agentId || input.agentName || 'project',
  ].join(':');
  const id = idBase.replace(/[^a-zA-Z0-9:_-]+/g, '-');
  try {
    db.insert(schema.recommendations)
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
      .run();
    const row = db.select().from(schema.recommendations).where(eq(schema.recommendations.id, id)).get();
    return row ? rowToDict(row) : null;
  } catch (e) {
    console.error('[recommendations] failed to upsert recommendation:', e);
    return null;
  }
}

export function listRecommendations(project: string): RecommendationRow[] {
  return db
    .select()
    .from(schema.recommendations)
    .where(eq(schema.recommendations.project, project))
    .orderBy(desc(schema.recommendations.updatedAt))
    .all()
    .map(rowToDict);
}

export function updateRecommendationStatus(project: string, id: string, status: RecommendationStatus): RecommendationRow | null {
  const now = Date.now() / 1000;
  db.update(schema.recommendations)
    .set({ status, updatedAt: now })
    .where(and(eq(schema.recommendations.project, project), eq(schema.recommendations.id, id)))
    .run();
  const row = db.select().from(schema.recommendations)
    .where(and(eq(schema.recommendations.project, project), eq(schema.recommendations.id, id)))
    .get();
  return row ? rowToDict(row) : null;
}
