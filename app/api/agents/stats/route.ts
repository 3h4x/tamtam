import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { errMsg } from '@/lib/shared/types';
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache';

export interface PerAgentStat {
  /** Agent kind without the `agent:` prefix — same as the agent name. */
  name: string;
  runs: number;
  finishedRuns: number;
  successfulRuns: number;
  avgDurationMs: number | null;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  modifiedFilesCount: number;
  /**
   * For agents whose name contains "review" — total `fix` jobs sharing a
   * release_id with one of this agent's runs. Approximates "fixes triggered
   * per review". Always 0 for non-review agents.
   */
  reviewFixesTriggered: number;
}

interface AgentStatsResponse {
  project: string;
  agents: PerAgentStat[];
}

// Project-scoped agent-run rollup for the AgentsStats panel. The query pulls
// every `agent:*` job row for the project and aggregates in JS, so under the
// cold project-page request stampede (a dozen requests fire on mount and
// contend for git/DB) it took several seconds. It's read-only and a stats panel
// tolerates brief staleness, so serve it stale-while-revalidate: only the first
// load per project is slow, later loads return the last value immediately and
// refresh in the background. Pinned to globalThis because Next.js duplicates
// route modules across bundle realms.
declare global {
  var __tamtamAgentStatsCache: Map<string, { value: AgentStatsResponse; time: number }> | undefined;
  var __tamtamAgentStatsInflight: Map<string, Promise<AgentStatsResponse>> | undefined;
}
const AGENT_STATS_TTL_MS = 10_000;

function safeJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    /* ignore */
  }
  return [];
}

async function computeAgentStats(project: string): Promise<AgentStatsResponse> {
  const agentJobs = await db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.project, project), like(schema.jobs.kind, 'agent:%')));

  // Group by agent name (kind = `agent:<name>`)
  const byAgent = new Map<string, typeof agentJobs>();
  for (const j of agentJobs) {
    const name = j.kind.slice('agent:'.length);
    if (!byAgent.has(name)) byAgent.set(name, []);
    byAgent.get(name)!.push(j);
  }

  // Pre-collect all release IDs touched by review-style agents so we can
  // count their fix children in a single query.
  const reviewReleaseIds = new Set<string>();
  for (const [name, jobs] of byAgent) {
    if (!/review/i.test(name)) continue;
    for (const j of jobs) if (j.releaseId) reviewReleaseIds.add(j.releaseId);
  }
  const fixesByRelease = new Map<string, number>();
  if (reviewReleaseIds.size > 0) {
    // Push the release-id filter into the DB instead of fetching all of
    // the project's `fix` rows and discarding the ones that don't match.
    // On projects with many fix jobs but only a handful of review-linked
    // releases, this collapses the row transfer to just the rows we
    // actually need to count.
    const fixJobs = await db
      .select({ releaseId: schema.jobs.releaseId })
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.project, project),
        eq(schema.jobs.kind, 'fix'),
        inArray(schema.jobs.releaseId, Array.from(reviewReleaseIds)),
      ));
    for (const f of fixJobs) {
      if (!f.releaseId) continue;
      fixesByRelease.set(f.releaseId, (fixesByRelease.get(f.releaseId) ?? 0) + 1);
    }
  }

  const perAgent: PerAgentStat[] = [];
  for (const [name, jobs] of byAgent) {
    let durationSum = 0;
    let durationCount = 0;
    let finished = 0;
    let successful = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    let costUsd = 0;
    let modifiedFilesCount = 0;
    let reviewFixesTriggered = 0;
    const isReviewAgent = /review/i.test(name);

    for (const j of jobs) {
      if (j.finishedAt !== null) finished += 1;
      if (j.exitCode === 0) successful += 1;
      if (j.durationMs && j.durationMs > 0) {
        durationSum += j.durationMs;
        durationCount += 1;
      }
      inputTokens += j.inputTokens ?? 0;
      outputTokens += j.outputTokens ?? 0;
      cacheReadTokens += j.cacheReadTokens ?? 0;
      cacheCreateTokens += j.cacheCreateTokens ?? 0;
      costUsd += j.costUsd ?? 0;
      modifiedFilesCount += safeJsonArray(j.modifiedFiles).length;
      if (isReviewAgent && j.releaseId) {
        reviewFixesTriggered += fixesByRelease.get(j.releaseId) ?? 0;
      }
    }

    perAgent.push({
      name,
      runs: jobs.length,
      finishedRuns: finished,
      successfulRuns: successful,
      avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
      totalDurationMs: durationSum,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costUsd: Math.round(costUsd * 10000) / 10000,
      modifiedFilesCount,
      reviewFixesTriggered,
    });
  }

  perAgent.sort((a, b) => a.name.localeCompare(b.name));
  return { project, agents: perAgent };
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ detail: 'project query param is required' }, { status: 400 });

  try {
    const store: SwrStore<AgentStatsResponse> = {
      cache: (globalThis.__tamtamAgentStatsCache ??= new Map()),
      inflight: (globalThis.__tamtamAgentStatsInflight ??= new Map()),
    };
    const value = await swrGet(store, project, AGENT_STATS_TTL_MS, () => computeAgentStats(project));
    return NextResponse.json(value);
  } catch (err) {
    return NextResponse.json({ detail: errMsg(err) }, { status: 500 });
  }
}
