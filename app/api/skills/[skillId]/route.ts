import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { isDefaultSkillId } from '@/lib/agents/default-agent-skills';
import { recordSkillRevision } from '@/lib/agents/revisions';
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;
  const rows = await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).limit(1);
  const skill = rows[0] ?? null;
  if (!skill) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;

  if (isDefaultSkillId(skillId)) {
    return NextResponse.json({ detail: 'default skills are read-only' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ detail: 'body must be an object' }, { status: 400 });
  }

  const existingRows = await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).limit(1);
  const existing = existingRows[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const { name, description, content, note } = body as { name?: unknown; description?: unknown; content?: unknown; note?: unknown };
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (name !== undefined) {
    if (typeof name !== 'string') return NextResponse.json({ detail: 'name must be a string' }, { status: 400 });
    updates.name = name.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string') return NextResponse.json({ detail: 'description must be a string' }, { status: 400 });
    updates.description = description.trim();
  }
  if (content !== undefined) {
    if (typeof content !== 'string') return NextResponse.json({ detail: 'content must be a string' }, { status: 400 });
    updates.content = content;
  }

  await recordSkillRevision(existing, note);
  await db.update(schema.skills).set(updates).where(eq(schema.skills.id, skillId));
  const skillRows = await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).limit(1);
  const skill = skillRows[0] ?? null;
  return NextResponse.json({ skill });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;
  if (isDefaultSkillId(skillId)) {
    return NextResponse.json({ detail: 'default skills are read-only' }, { status: 403 });
  }
  await db.delete(schema.skills).where(eq(schema.skills.id, skillId));
  return NextResponse.json({ status: 'deleted' });
}
