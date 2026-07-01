import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listAgentRevisions } from '@/lib/agents/revisions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  const existing = (await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1))[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const revisions = await listAgentRevisions(agentId);
  return NextResponse.json({ revisions });
}
