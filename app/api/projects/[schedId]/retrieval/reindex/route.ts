import { NextResponse } from 'next/server';
import { reindexProject } from '@/lib/agents/retrieval/reindex-project';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ schedId: string }> }
): Promise<NextResponse> {
  const { schedId } = await params;
  const result = await reindexProject(schedId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Reindex failed' }, { status: result.status });
  }

  return NextResponse.json({
    chunks: result.chunks,
    indexedSources: result.indexedSources,
    skippedSources: result.skippedSources,
    diagnostics: result.diagnostics,
  });
}
