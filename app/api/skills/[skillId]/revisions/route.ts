import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listSkillRevisions } from '@/lib/agents/revisions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params;
  const existing = (await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(eq(schema.skills.id, skillId))
    .limit(1))[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const revisions = await listSkillRevisions(skillId);
  return NextResponse.json({ revisions });
}
