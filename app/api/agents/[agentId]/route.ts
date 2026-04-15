import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { checkAuth } from '@/lib/auth';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { agentId } = await params;

  const existing = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.skillIds !== undefined) updates.skillIds = JSON.stringify(body.skillIds);
  if (body.model !== undefined) updates.model = body.model;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.schedule !== undefined) updates.schedule = body.schedule || null;
  if (body.runner !== undefined) updates.runner = body.runner;

  db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).run();
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  return NextResponse.json({ agent });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { agentId } = await params;
  db.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
  return NextResponse.json({ status: 'deleted' });
}
