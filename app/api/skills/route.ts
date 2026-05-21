import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { seedDefaultSkills } from '@/lib/agents/default-agent-skills';

export async function GET() {
  seedDefaultSkills();
  const skills = await db.select().from(schema.skills);
  return NextResponse.json({ skills });
}

export async function POST(request: NextRequest) {
  let body: { name?: unknown; description?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ detail: 'name is required' }, { status: 400 });
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';

  const now = Date.now() / 1000;
  // Append a short random suffix so two POSTs landing in the same millisecond
  // don't collide on the unique `id` constraint. crypto.randomUUID() would
  // also work; keeping the `skill-` prefix preserves the existing format that
  // operators can scan visually in DB rows / logs.
  const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const skill = { id, name, description, content, createdAt: now, updatedAt: now };

  await db.insert(schema.skills).values(skill);
  return NextResponse.json({ skill }, { status: 201 });
}
