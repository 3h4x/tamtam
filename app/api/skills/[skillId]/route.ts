import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { isDefaultSkillId } from '@/lib/agents/default-agent-skills';
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

  const existingRows = await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).limit(1);
  const existing = existingRows[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description.trim();
  if (body.content !== undefined) updates.content = body.content;

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
