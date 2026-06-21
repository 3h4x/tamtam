import { NextRequest, NextResponse } from 'next/server';
import { getSettings } from '@/lib/shared/config';
import {
  countByStatusAllProjects,
  countShippedTodayAllProjects,
  listRecentInitiatives,
} from '@/lib/orchestrator/initiatives-store';
import {
  listAllOpenRecommendations,
  listAllResolvedRecommendations,
  type RecommendationRow,
} from '@/lib/recommendations/recommendations';

export interface OrchestratorStatsResponse {
  generatedAt: number;
  flags: {
    orchestratorEnabled: boolean;
    initiativeEngineEnabled: boolean;
    initiativeMiningEnabled: boolean;
    maxShipsPerDay: number;
  };
  initiatives: {
    counts: Record<'proposed' | 'queued' | 'running' | 'shipped' | 'failed' | 'rejected' | 'superseded', number>;
    shippedToday: number;
    recent: Array<{ project: string; kind: string; status: string; source: string; score: number; updatedAt: number }>;
  };
  actions: {
    last24h: { boosts: number; autopilot: number; healthConcerns: number };
    recent: Array<{ project: string; type: string; title: string; status: string; agentName: string | null; updatedAt: number }>;
  };
}

const ORCHESTRATOR_TYPES = new Set(['orchestrator_boost', 'agent_autopilot', 'orchestrator_agent_health']);

// recommendations table stores created_at / updated_at as epoch-seconds (doublePrecision, divided by 1000 at write time)
const SECONDS_PER_MS = 1 / 1000;

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const settings = getSettings();
    const nowMs = Date.now();
    const cutoffSec = nowMs * SECONDS_PER_MS - 24 * 60 * 60; // 24h ago in seconds

    const [counts, shippedToday, recentRows, openRecs, resolvedRecs] = await Promise.all([
      countByStatusAllProjects(),
      countShippedTodayAllProjects(nowMs),
      listRecentInitiatives(15),
      listAllOpenRecommendations(),
      listAllResolvedRecommendations(),
    ]);

    const allRecs: RecommendationRow[] = [...openRecs, ...resolvedRecs];
    const orchestratorRecs = allRecs.filter((r) => ORCHESTRATOR_TYPES.has(r.type));

    const last24h = { boosts: 0, autopilot: 0, healthConcerns: 0 };
    for (const r of orchestratorRecs) {
      if (r.updated_at >= cutoffSec) {
        if (r.type === 'orchestrator_boost') last24h.boosts += 1;
        else if (r.type === 'agent_autopilot') last24h.autopilot += 1;
        else if (r.type === 'orchestrator_agent_health') last24h.healthConcerns += 1;
      }
    }

    // Sort all orchestrator recs by updated_at desc, take top 15
    const sortedRecs = orchestratorRecs
      .slice()
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 15);

    const body: OrchestratorStatsResponse = {
      generatedAt: nowMs,
      flags: {
        orchestratorEnabled: settings.orchestrator_enabled,
        initiativeEngineEnabled: settings.initiative_engine_enabled,
        initiativeMiningEnabled: settings.initiative_mining_enabled,
        maxShipsPerDay: settings.initiative_max_ships_per_day,
      },
      initiatives: {
        counts,
        shippedToday,
        recent: recentRows.map((r) => ({
          project: r.project,
          kind: r.kind,
          status: r.status,
          source: r.source,
          score: r.score,
          updatedAt: r.updatedAt,
        })),
      },
      actions: {
        last24h,
        recent: sortedRecs.map((r) => ({
          project: r.project,
          type: r.type,
          title: r.title,
          status: r.status,
          agentName: r.agent_name,
          updatedAt: r.updated_at,
        })),
      },
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error('[stats/orchestrator] failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
