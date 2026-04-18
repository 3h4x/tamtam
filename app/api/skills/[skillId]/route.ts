import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;
  const skill = db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).get();
  if (!skill) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;

  const existing = db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).get();
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description.trim();
  if (body.content !== undefined) updates.content = body.content;

  db.update(schema.skills).set(updates).where(eq(schema.skills.id, skillId)).run();
  const skill = db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).get();
  return NextResponse.json({ skill });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> }
) {
  const { skillId } = await params;
  db.delete(schema.skills).where(eq(schema.skills.id, skillId)).run();
  return NextResponse.json({ status: 'deleted' });
}
