import { NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { getAllAgentsCachedAsync } from '@/lib/agents/agents-cache';
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
  | 'stuck'
  | 'agent_running'
  | 'paused'
  | 'error'
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
    stuck: number;
    agent_running: number;
    error: number;
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
  stuck: 0,
  error: 1,
  attention: 2,
  paused: 3,
  releasing: 4,
  agent_running: 5,
  shipping: 6,
  active: 7,
  idle: 8,
} satisfies Record<BridgeProjectStatus, number>;
// A release in flight longer than this is "stuck" — operator should look.
const STUCK_RELEASE_MS = 30 * 60 * 1000;

let cache: { body: BridgeResponse; expiresAt: number } | null = null;

interface ProjectAccum {
  lastPushAt: number | null;
  lastPushOk: boolean | null;
  lastReleaseAt: number | null;
  lastReleaseOk: boolean | null;
  lastAgentAt: number | null;
  releaseRunning: boolean;
  releaseStartedAt: number | null;
  agentRunning: boolean;
}

function emptyAccum(): ProjectAccum {
  return {
    lastPushAt: null,
    lastPushOk: null,
    lastReleaseAt: null,
    lastReleaseOk: null,
    lastAgentAt: null,
    releaseRunning: false,
    releaseStartedAt: null,
    agentRunning: false,
  };
}

function deriveStatus(p: BridgeProject, now: number, a: ProjectAccum): BridgeProjectStatus {
  // Stuck release takes precedence (release running too long)
  if (p.releaseRunning && a.releaseStartedAt != null && (now - a.releaseStartedAt * 1000) > STUCK_RELEASE_MS) {
    return 'stuck';
  }
  // Active release takes precedence over paused
  if (p.releaseRunning) {
    return 'releasing';
  }
  // Paused (only if not releasing)
  if (p.paused) return 'paused';
  // Failed operations (both push and release)
  if (p.lastReleaseOk === false || p.lastPushOk === false) return 'attention';
  // Active agent run
  if (a.agentRunning) return 'agent_running';
  // Recent push (shipping)
  if (p.lastPushAt != null && now - p.lastPushAt * 1000 < SHIP_WINDOW_MS) return 'shipping';
  // Recent agent run (active)
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
  // Drop agents whose project is disabled / archived — otherwise a disabled
  // project that still has enabled agent rows would appear in the bridge
  // fleet and skew every "all projects shipped" / pace / orchestrator signal.
  const enabledProjectNames = new Set(enabledProjects.map((p) => p.name));
  const agentCount = new Map<string, number>();
  for (const a of agents) {
    if (a.enabled === false) continue;
    if (a.kind === 'system') continue;
    if (!enabledProjectNames.has(a.project)) continue;
    incrementAgentCount(agentCount, a.project);
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
        if (a.releaseStartedAt === null || j.startedAt < a.releaseStartedAt) {
          a.releaseStartedAt = j.startedAt;
        }
      } else if (a.lastReleaseAt === null || j.finishedAt > a.lastReleaseAt) {
        a.lastReleaseAt = j.finishedAt;
        a.lastReleaseOk = j.exitCode === 0;
      }
    } else if (j.kind.startsWith('agent:')) {
      if (a.lastAgentAt === null || j.startedAt > a.lastAgentAt) {
        a.lastAgentAt = j.startedAt;
      }
      if (j.finishedAt === null) a.agentRunning = true;
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
      proj.status = deriveStatus(proj, now, a);
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
    stuck: projects.filter((p) => p.status === 'stuck').length,
    agent_running: projects.filter((p) => p.status === 'agent_running').length,
    error: projects.filter((p) => p.status === 'error').length,
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
