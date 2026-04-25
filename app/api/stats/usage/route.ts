import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/job-storage';
import { costUsd, PRICE_PER_MTOK } from '@/lib/usage-pricing';

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
} as const;

type Window = keyof typeof WINDOWS;

const CACHE_TTL_MS = 60_000;
const cache = new Map<Window, { body: UsageResponse; expiresAt: number }>();

export interface ProjectUsageRow {
  project: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  costUsd: number;
  lastRunAt: number | null;
}

export interface AgentUsageRow {
  kind: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageResponse {
  window: Window;
  generatedAt: number;
  pricing: typeof PRICE_PER_MTOK;
  totals: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  projects: ProjectUsageRow[];
  agents: AgentUsageRow[];
}

export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get('window') ?? '30d';
  const window: Window = (Object.keys(WINDOWS) as Window[]).includes(param as Window)
    ? (param as Window)
    : '30d';

  const cached = cache.get(window);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const cutoff = window === 'all' ? -Infinity : Date.now() / 1000 - WINDOWS[window] / 1000;
  const jobs = listJobs().filter((j) => j.startedAt >= cutoff);

  const byProject = new Map<string, ProjectUsageRow>();
  const byKind = new Map<string, AgentUsageRow>();

  for (const j of jobs) {
    const row = byProject.get(j.project) ?? {
      project: j.project,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      lastRunAt: null,
    };
    row.runs += 1;
    row.inputTokens += j.inputTokens ?? 0;
    row.outputTokens += j.outputTokens ?? 0;
    row.cacheReadTokens += j.cacheReadTokens ?? 0;
    row.cacheCreateTokens += j.cacheCreateTokens ?? 0;
    if (row.lastRunAt === null || j.startedAt > row.lastRunAt) {
      row.lastRunAt = j.startedAt;
    }
    byProject.set(j.project, row);

    const agentRow = byKind.get(j.kind) ?? {
      kind: j.kind,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    agentRow.runs += 1;
    agentRow.inputTokens += j.inputTokens ?? 0;
    agentRow.outputTokens += j.outputTokens ?? 0;
    agentRow.cacheReadTokens += j.cacheReadTokens ?? 0;
    agentRow.cacheCreateTokens += j.cacheCreateTokens ?? 0;
    byKind.set(j.kind, agentRow);
  }

  const projects = Array.from(byProject.values()).map((r) => {
    r.totalTokens = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens;
    r.costUsd = costUsd(r);
    return r;
  });
  projects.sort((a, b) => b.costUsd - a.costUsd);

  const agents = Array.from(byKind.values()).map((r) => {
    r.totalTokens = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens;
    r.costUsd = costUsd(r);
    return r;
  });
  agents.sort((a, b) => b.costUsd - a.costUsd);

  const totals = projects.reduce(
    (acc, r) => ({
      runs: acc.runs + r.runs,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreateTokens: acc.cacheCreateTokens + r.cacheCreateTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, costUsd: 0 }
  );

  const body: UsageResponse = {
    window,
    generatedAt: Date.now(),
    pricing: PRICE_PER_MTOK,
    totals,
    projects,
    agents,
  };
  cache.set(window, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(body);
}
