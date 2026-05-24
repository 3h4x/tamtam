import { NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { getAllAgentsCachedAsync } from '@/lib/agents/agents-cache';
import { canonicalAgentNameKey } from '@/lib/agents/agent-name';
import { scanFileAgents } from '@/lib/agents/tamtam-file-agents';
import { listEnabledProjects, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import {
  readEnabledProviderSnapshots,
  scheduledBurnRateBlockedAcrossProviders,
  type SchedulerThrottle,
} from '@/lib/shared/job-control';
import { computeGlobalPace, type GlobalPace } from '@/lib/usage/quota-pace';

// "The Bridge" — a compact, generic command-center view of the fleet:
//   1) Are we burning tokens at a healthy pace? (global + per-provider)
//   2) Are the agent-driven projects actually shipping? (push / release state)
//   3) Is anything stuck, paused, or over the burn cap?
//
// Generic by construction: it iterates over whatever projects currently have
// at least one enabled non-system agent — no project names are hardcoded — so
// it works the same for any fleet wired into TamTam.

export type BridgeProjectStatus =
  | 'releasing'
  | 'paused'
  | 'attention'
  | 'shipping'
  | 'active'
  | 'idle';

export interface BridgeProject {
  project: string;
  /** # of enabled, non-system agents configured on this project. */
  agents: number;
  status: BridgeProjectStatus;
  paused: boolean;
  /** A release pipeline is in flight for this project right now. */
  releaseRunning: boolean;
  /** Epoch SECONDS of the latest terminal push (matches job timestamps). */
  lastPushAt: number | null;
  lastPushOk: boolean | null;
  lastReleaseAt: number | null;
  lastReleaseOk: boolean | null;
  /** Epoch SECONDS of the latest scheduled agent run (kind `agent:*`). */
  lastAgentAt: number | null;
}

export interface BridgeResponse {
  /** Epoch MILLISECONDS the payload was assembled. */
  generatedAt: number;
  globalPace: GlobalPace;
  throttle: SchedulerThrottle | null;
  projects: BridgeProject[];
  summary: {
    projects: number;
    agentsEnabled: number;
    shipping: number;
    attention: number;
    releasing: number;
    paused: number;
    active: number;
    idle: number;
    runningReleases: number;
  };
}

// A push within this window counts as "shipping"; an agent run within the
// active window (but no recent push) counts as "active". Both are cosmetic
// thresholds for the at-a-glance status dot, not pipeline logic.
const SHIP_WINDOW_MS = 2 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 15_000;
const STATUS_SORT_RANK = {
  attention: 0,
  paused: 1,
  releasing: 2,
  shipping: 3,
  active: 4,
  idle: 5,
} satisfies Record<BridgeProjectStatus, number>;

let cache: { body: BridgeResponse; expiresAt: number } | null = null;

interface ProjectAccum {
  lastPushAt: number | null;
  lastPushOk: boolean | null;
  lastReleaseAt: number | null;
  lastReleaseOk: boolean | null;
  lastAgentAt: number | null;
  releaseRunning: boolean;
}

function emptyAccum(): ProjectAccum {
  return {
    lastPushAt: null,
    lastPushOk: null,
    lastReleaseAt: null,
    lastReleaseOk: null,
    lastAgentAt: null,
    releaseRunning: false,
  };
}

function deriveStatus(p: BridgeProject, now: number): BridgeProjectStatus {
  if (p.releaseRunning) return 'releasing';
  if (p.paused) return 'paused';
  if (p.lastReleaseOk === false || p.lastPushOk === false) return 'attention';
  if (p.lastPushAt != null && now - p.lastPushAt * 1000 < SHIP_WINDOW_MS) return 'shipping';
  if (p.lastAgentAt != null && now - p.lastAgentAt * 1000 < ACTIVE_WINDOW_MS) return 'active';
  return 'idle';
}

function incrementAgentCount(counts: Map<string, number>, project: string): void {
  counts.set(project, (counts.get(project) ?? 0) + 1);
}

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.body);
  }

  // 1) Which projects have ≥1 enabled, non-system agent? (the fleet we watch)
  const [agents] = await Promise.all([
    getAllAgentsCachedAsync(),
    refreshProjectsCacheSync(),
  ]);
  const enabledProjects = listEnabledProjects();
  const agentCount = new Map<string, number>();
  const dbAgentKeys = new Set<string>();
  for (const a of agents) {
    dbAgentKeys.add(`${a.project}:${canonicalAgentNameKey(a.name)}`);
    if (a.enabled === false) continue;
    if (a.kind === 'system') continue;
    incrementAgentCount(agentCount, a.project);
  }
  for (const project of enabledProjects) {
    let fileAgents: ReturnType<typeof scanFileAgents>;
    try {
      fileAgents = scanFileAgents(project.path, project.name);
    } catch (err) {
      console.error(`[stats-bridge] file-agent scan failed for ${project.name}:`, err);
      continue;
    }
    for (const fa of fileAgents) {
      if (dbAgentKeys.has(`${fa.project}:${canonicalAgentNameKey(fa.name)}`)) continue;
      if (fa.enabled === false) continue;
      if (fa.kind === 'system') continue;
      incrementAgentCount(agentCount, fa.project);
    }
  }

  // 2) Per-project push/release/agent activity — one pass over all jobs,
  //    bucketed only for projects in the agent set.
  const accum = new Map<string, ProjectAccum>();
  for (const project of agentCount.keys()) accum.set(project, emptyAccum());

  for (const j of listJobs()) {
    const a = accum.get(j.project);
    if (!a) continue;
    if (j.kind === 'push' && j.finishedAt !== null) {
      if (a.lastPushAt === null || j.finishedAt > a.lastPushAt) {
        a.lastPushAt = j.finishedAt;
        a.lastPushOk = j.exitCode === 0;
      }
    } else if (j.kind === 'release') {
      if (j.finishedAt === null) {
        a.releaseRunning = true;
      } else if (a.lastReleaseAt === null || j.finishedAt > a.lastReleaseAt) {
        a.lastReleaseAt = j.finishedAt;
        a.lastReleaseOk = j.exitCode === 0;
      }
    } else if (j.kind.startsWith('agent:')) {
      if (a.lastAgentAt === null || j.startedAt > a.lastAgentAt) {
        a.lastAgentAt = j.startedAt;
      }
    }
  }

  // 3) Paused state (cheap cached read).
  const pausedByName = new Map<string, boolean>();
  for (const p of enabledProjects) pausedByName.set(p.name, !!p.paused);

  const now = Date.now();
  const projects: BridgeProject[] = Array.from(agentCount.entries())
    .map(([project, count]) => {
      const a = accum.get(project) ?? emptyAccum();
      const proj: BridgeProject = {
        project,
        agents: count,
        status: 'idle',
        paused: pausedByName.get(project) ?? false,
        releaseRunning: a.releaseRunning,
        lastPushAt: a.lastPushAt,
        lastPushOk: a.lastPushOk,
        lastReleaseAt: a.lastReleaseAt,
        lastReleaseOk: a.lastReleaseOk,
        lastAgentAt: a.lastAgentAt,
      };
      proj.status = deriveStatus(proj, now);
      return proj;
    })
    .sort((x, y) => {
      // Surface what needs eyes first, then most-recently-active.
      const d = STATUS_SORT_RANK[x.status] - STATUS_SORT_RANK[y.status];
      if (d !== 0) return d;
      return (y.lastAgentAt ?? 0) - (x.lastAgentAt ?? 0);
    });

  // 4) Pace + scheduler throttle (DB-resilient so a rate-limited provider
  //    still appears via its last persisted snapshot).
  let globalPace: GlobalPace;
  try {
    globalPace = computeGlobalPace(await readEnabledProviderSnapshots());
  } catch {
    globalPace = computeGlobalPace([]);
  }
  let throttle: SchedulerThrottle | null = null;
  try {
    throttle = scheduledBurnRateBlockedAcrossProviders();
  } catch {
    throttle = null;
  }

  const summary = {
    projects: projects.length,
    agentsEnabled: Array.from(agentCount.values()).reduce((s, n) => s + n, 0),
    shipping: projects.filter((p) => p.status === 'shipping').length,
    attention: projects.filter((p) => p.status === 'attention').length,
    releasing: projects.filter((p) => p.status === 'releasing').length,
    paused: projects.filter((p) => p.status === 'paused').length,
    active: projects.filter((p) => p.status === 'active').length,
    idle: projects.filter((p) => p.status === 'idle').length,
    runningReleases: projects.filter((p) => p.releaseRunning).length,
  };

  const body: BridgeResponse = {
    generatedAt: now,
    globalPace,
    throttle,
    projects,
    summary,
  };
  cache = { body, expiresAt: Date.now() + CACHE_TTL_MS };
  return NextResponse.json(body);
}
