import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { runProbes } from '@/lib/orchestrator/initiative-probes';
import { mineCandidates } from '@/lib/orchestrator/initiative-miner';

export interface InitiativePreviewResponse {
  project: string;
  generatedAt: number;
  candidates: Array<{
    kind: string;
    title: string;
    rationale: string;
    score: number;
    dedupKey: string;
  }>;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  try {
    const path = resolveProjectPath(projectName);
    if (!path) {
      return NextResponse.json({ detail: 'project not found' }, { status: 404 });
    }

    const results = await runProbes(projectName, path);
    const candidates = mineCandidates(results);

    const body: InitiativePreviewResponse = {
      project: projectName,
      generatedAt: Date.now(),
      candidates: candidates.map((c) => ({
        kind: c.kind,
        title: c.title,
        rationale: c.rationale,
        score: c.score ?? 0,
        dedupKey: c.dedupKey,
      })),
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error(`[api/initiatives/preview] failed for ${projectName}:`, error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
