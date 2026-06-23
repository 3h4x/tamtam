import { desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';

type SkillSnapshot = typeof schema.skills.$inferSelect;
type AgentSnapshot = typeof schema.agents.$inferSelect;

export type RevisionKind = 'skill' | 'agent';

export type SkillRevision = typeof schema.skillRevisions.$inferSelect & {
  parsedSnapshot: SkillSnapshot | null;
};

export type AgentRevision = typeof schema.agentRevisions.$inferSelect & {
  parsedSnapshot: AgentSnapshot | null;
};

function nowSeconds(): number {
  return Date.now() / 1000;
}

function auditAuthor(): string {
  const configured = getSettings().user_name?.trim();
  if (configured) return configured;
  return process.env.TAMTAM_USER || process.env.USER || process.env.LOGNAME || 'unknown';
}

function normalizeNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

async function pruneSkillRevisions(entityId: string): Promise<void> {
  const limit = getSettings().skill_revision_retention_count ?? 50;
  if (limit <= 0) return;
  const rows = await db
    .select({ id: schema.skillRevisions.id })
    .from(schema.skillRevisions)
    .where(eq(schema.skillRevisions.entityId, entityId))
    .orderBy(desc(schema.skillRevisions.createdAt), desc(schema.skillRevisions.id));
  const oldIds = rows.slice(limit).map((row) => row.id);
  if (oldIds.length === 0) return;
  await db.delete(schema.skillRevisions)
    .where(inArray(schema.skillRevisions.id, oldIds))
    .execute();
}

async function pruneAgentRevisions(entityId: string): Promise<void> {
  const limit = getSettings().skill_revision_retention_count ?? 50;
  if (limit <= 0) return;
  const rows = await db
    .select({ id: schema.agentRevisions.id })
    .from(schema.agentRevisions)
    .where(eq(schema.agentRevisions.entityId, entityId))
    .orderBy(desc(schema.agentRevisions.createdAt), desc(schema.agentRevisions.id));
  const oldIds = rows.slice(limit).map((row) => row.id);
  if (oldIds.length === 0) return;
  await db.delete(schema.agentRevisions)
    .where(inArray(schema.agentRevisions.id, oldIds))
    .execute();
}

export async function recordSkillRevision(snapshot: SkillSnapshot, note?: unknown): Promise<void> {
  await db.insert(schema.skillRevisions).values({
    entityId: snapshot.id,
    snapshot: JSON.stringify(snapshot),
    author: auditAuthor(),
    note: normalizeNote(note),
    createdAt: nowSeconds(),
  }).execute();
  await pruneSkillRevisions(snapshot.id);
}

export async function recordAgentRevision(snapshot: AgentSnapshot, note?: unknown): Promise<void> {
  await db.insert(schema.agentRevisions).values({
    entityId: snapshot.id,
    snapshot: JSON.stringify(snapshot),
    author: auditAuthor(),
    note: normalizeNote(note),
    createdAt: nowSeconds(),
  }).execute();
  await pruneAgentRevisions(snapshot.id);
}

export async function listSkillRevisions(entityId: string): Promise<SkillRevision[]> {
  const rows = await db
    .select()
    .from(schema.skillRevisions)
    .where(eq(schema.skillRevisions.entityId, entityId))
    .orderBy(desc(schema.skillRevisions.createdAt), desc(schema.skillRevisions.id));
  return rows.map((row) => ({ ...row, parsedSnapshot: parseSnapshot<SkillSnapshot>(row.snapshot) }));
}

export async function listAgentRevisions(entityId: string): Promise<AgentRevision[]> {
  const rows = await db
    .select()
    .from(schema.agentRevisions)
    .where(eq(schema.agentRevisions.entityId, entityId))
    .orderBy(desc(schema.agentRevisions.createdAt), desc(schema.agentRevisions.id));
  return rows.map((row) => ({ ...row, parsedSnapshot: parseSnapshot<AgentSnapshot>(row.snapshot) }));
}

function parseSnapshot<T>(snapshot: string): T | null {
  try {
    return JSON.parse(snapshot) as T;
  } catch {
    return null;
  }
}
