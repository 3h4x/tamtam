import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { seedDefaultSkills } from '@/lib/default-agent-skills';

export async function GET() {
  seedDefaultSkills();
  const skills = db.select().from(schema.skills).all();
  return NextResponse.json({ skills });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, description, content } = body;

  if (!name?.trim()) {
    return NextResponse.json({ detail: 'name is required' }, { status: 400 });
  }

  const now = Date.now() / 1000;
  const id = `skill-${Date.now()}`;
  const skill = {
    id,
    name: name.trim(),
    description: description?.trim() || '',
    content: content || '',
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.skills).values(skill).run();
  return NextResponse.json({ skill }, { status: 201 });
}
