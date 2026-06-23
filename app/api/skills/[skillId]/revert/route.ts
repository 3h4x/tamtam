import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { isDefaultSkillId } from '@/lib/agents/default-agent-skills';
import { recordSkillRevision } from '@/lib/agents/revisions';

type SkillSnapshot = typeof schema.skills.$inferSelect;

function parseSnapshot(raw: string): SkillSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SkillSnapshot>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.content !== 'string'
    ) {
      return null;
    }
    return parsed as SkillSnapshot;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;
  if (isDefaultSkillId(skillId)) {
    return NextResponse.json({ detail: 'default skills are read-only' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { revisionId?: unknown; note?: unknown };
  const revisionId = Number(body.revisionId);
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    return NextResponse.json({ detail: 'revisionId is required' }, { status: 400 });
  }

  const existing = (await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.id, skillId))
    .limit(1))[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const revision = (await db
    .select()
    .from(schema.skillRevisions)
    .where(and(
      eq(schema.skillRevisions.entityId, skillId),
      eq(schema.skillRevisions.id, revisionId),
    ))
    .limit(1))[0] ?? null;
  if (!revision) return NextResponse.json({ detail: 'revision not found' }, { status: 404 });

  const snapshot = parseSnapshot(revision.snapshot);
  if (!snapshot) return NextResponse.json({ detail: 'revision snapshot is invalid' }, { status: 422 });

  await recordSkillRevision(existing, body.note ?? `Revert to revision ${revisionId}`);
  await db.update(schema.skills)
    .set({
      name: snapshot.name,
      description: snapshot.description,
      content: snapshot.content,
      updatedAt: Date.now() / 1000,
    })
    .where(eq(schema.skills.id, skillId))
    .execute();

  const skill = (await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).limit(1))[0] ?? null;
  return NextResponse.json({ skill });
}
