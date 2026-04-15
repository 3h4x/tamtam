import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { checkAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  let agents;
  if (project) {
    agents = db.select().from(schema.agents).where(eq(schema.agents.project, project)).all();
  } else {
    agents = db.select().from(schema.agents).all();
  }
  return NextResponse.json({ agents });
}

export async function POST(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const body = await request.json();
  const { name, project, skillIds, model, prompt, schedule, runner } = body;

  if (!name?.trim()) {
    return NextResponse.json({ detail: 'name is required' }, { status: 400 });
  }
  if (!project?.trim()) {
    return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  }

  const now = Date.now() / 1000;
  const id = `agent-${Date.now()}`;
  const agent = {
    id,
    name: name.trim(),
    project: project.trim(),
    skillIds: JSON.stringify(skillIds || []),
    model: model || 'sonnet',
    prompt: prompt || '',
    schedule: schedule || null,
    runner: runner || 'pm2',
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.agents).values(agent).run();
  return NextResponse.json({ agent }, { status: 201 });
}
