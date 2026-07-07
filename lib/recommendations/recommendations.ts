import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
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
  // Initial status for the row. Defaults to `open` (needs attention). AUTO
  // recommendations whose action is *already complete at creation* (e.g.
  // `orchestrator_boost` — the extra run was already fired) pass `resolved` so
  // they archive straight into the History tab instead of cluttering the
  // Unresolved queue, while staying inspectable.
  status?: RecommendationStatus;
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

export const ORCHESTRATOR_RECOMMENDATION_TYPES = [
  'orchestrator_boost',
  'agent_autopilot',
  'orchestrator_agent_health',
] as const;

export type OrchestratorRecommendationType = typeof ORCHESTRATOR_RECOMMENDATION_TYPES[number];

export interface OrchestratorRecommendationActivityRow {
  project: string;
  type: OrchestratorRecommendationType;
  title: string;
  status: RecommendationStatus;
  agentName: string | null;
  updatedAt: number;
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
  const status: RecommendationStatus = input.status ?? 'open';
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
        status,
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
          status,
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
  // every open recommendation just to count them in JS. Returning one row per
  // project keeps the global header chip poll cheap as the backlog grows.
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

export async function countRecentOrchestratorRecommendations(
  cutoffSec: number,
): Promise<Record<OrchestratorRecommendationType, number>> {
  const rows = await db
    .select({
      type: schema.recommendations.type,
      count: sql<number>`count(*)`,
    })
    .from(schema.recommendations)
    .where(and(
      inArray(schema.recommendations.type, [...ORCHESTRATOR_RECOMMENDATION_TYPES]),
      gte(schema.recommendations.updatedAt, cutoffSec),
    ))
    .groupBy(schema.recommendations.type);

  const counts: Record<OrchestratorRecommendationType, number> = {
    orchestrator_boost: 0,
    agent_autopilot: 0,
    orchestrator_agent_health: 0,
  };
  for (const row of rows) {
    if (isOrchestratorRecommendationType(row.type)) {
      counts[row.type] = Number(row.count);
    }
  }
  return counts;
}

export async function listRecentOrchestratorRecommendations(
  limit: number,
): Promise<OrchestratorRecommendationActivityRow[]> {
  const rows = await db
    .select({
      project: schema.recommendations.project,
      type: schema.recommendations.type,
      title: schema.recommendations.title,
      status: schema.recommendations.status,
      agentName: schema.recommendations.agentName,
      updatedAt: schema.recommendations.updatedAt,
    })
    .from(schema.recommendations)
    .where(inArray(schema.recommendations.type, [...ORCHESTRATOR_RECOMMENDATION_TYPES]))
    .orderBy(desc(schema.recommendations.updatedAt))
    .limit(limit);

  return rows
    .filter((row): row is typeof row & { type: OrchestratorRecommendationType } =>
      isOrchestratorRecommendationType(row.type),
    )
    .map((row) => ({
      project: row.project,
      type: row.type,
      title: row.title,
      status: row.status as RecommendationStatus,
      agentName: row.agentName,
      updatedAt: row.updatedAt,
    }));
}

function isOrchestratorRecommendationType(type: string): type is OrchestratorRecommendationType {
  return (ORCHESTRATOR_RECOMMENDATION_TYPES as readonly string[]).includes(type);
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

/**
 * Bulk-retire OPEN recommendations of `type` for a set of agents in one
 * statement — flips `open → resolved`, skipping any row an operator already
 * `dismissed`/`applied` and any row of another type. Used by the unfruitful
 * sweep to reconcile `agent_unfruitful` rows for agents that are now disabled:
 * those rows can never self-resolve (the recovery path only fires from a
 * scheduled run, and a disabled agent's cron is uninstalled), so without this
 * they linger in the decision feed forever — including rows created before
 * auto-disable recs were emitted `resolved`. Returns how many rows were retired.
 */
export async function resolveOpenRecommendationsForAgents(type: string, agentIds: string[]): Promise<number> {
  if (agentIds.length === 0) return 0;
  const now = Date.now() / 1000;
  const updated = await db
    .update(schema.recommendations)
    .set({ status: 'resolved', updatedAt: now })
    .where(
      and(
        eq(schema.recommendations.type, type),
        eq(schema.recommendations.status, 'open'),
        inArray(schema.recommendations.agentId, agentIds),
      ),
    )
    .returning({ id: schema.recommendations.id });
  return updated.length;
}
