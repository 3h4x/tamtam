import { NextRequest, NextResponse } from 'next/server';
import { getSettings } from '@/lib/shared/config';
import {
  countByStatusAllProjects,
  listAllInitiatives,
} from '@/lib/orchestrator/initiatives-store';

export interface InitiativesListResponse {
  generatedAt: number;
  flags: {
    engineEnabled: boolean;
    miningEnabled: boolean;
    maxShipsPerDay: number;
    maxBacklogPerProject: number;
  };
  counts: Record<
    'proposed' | 'queued' | 'running' | 'shipped' | 'failed' | 'rejected' | 'superseded',
    number
  >;
  initiatives: Array<{
    id: number;
    project: string;
    source: string;
    kind: string;
    title: string;
    rationale: string;
    score: number;
    status: string;
    releaseId: string | null;
    pinnedAt: number | null;
    updatedAt: number;
  }>;
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const settings = getSettings();
    const [counts, rows] = await Promise.all([
      countByStatusAllProjects(),
      listAllInitiatives(200),
    ]);

    const body: InitiativesListResponse = {
      generatedAt: Date.now(),
      flags: {
        engineEnabled: settings.initiative_engine_enabled,
        miningEnabled: settings.initiative_mining_enabled,
        maxShipsPerDay: settings.initiative_max_ships_per_day,
        maxBacklogPerProject: settings.initiative_max_backlog_per_project,
      },
      counts,
      initiatives: rows.map((r) => ({
        id: r.id,
        project: r.project,
        source: r.source,
        kind: r.kind,
        title: r.title,
        rationale: r.rationale,
        score: r.score,
        status: r.status,
        releaseId: r.releaseId,
        pinnedAt: r.pinnedAt,
        updatedAt: r.updatedAt,
      })),
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error('[api/initiatives] failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
