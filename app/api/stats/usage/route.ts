import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { costUsd, PRICE_PER_MTOK } from '@/lib/shared/usage-pricing';
import { estimateTokens } from '@/lib/jobs/prompt-size';

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
} as const;

type Window = keyof typeof WINDOWS;
const WINDOW_KEYS = Object.keys(WINDOWS) as Window[];

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
  commitProducingRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  costUsd: number;
  avgPromptBytes: number | null;
  avgPromptTokens: number | null;
  promptSamples: number;
}

export interface SkillUsageRow {
  skillId: string;
  skill: string;
  runs: number;
  promptTokens: number;
  cacheReadTokens: number;
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
  skills: SkillUsageRow[];
}

interface RunSkillAttribution {
  id: string;
  name: string;
  promptChars: number;
}

function parseRunSkills(raw: string | null | undefined): RunSkillAttribution[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const skills: RunSkillAttribution[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      skills.push({ id: item, name: item, promptChars: 0 });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) continue;
    skills.push({
      id: record.id,
      name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
      promptChars: typeof record.promptChars === 'number' && Number.isFinite(record.promptChars)
        ? Math.max(0, record.promptChars)
        : 0,
    });
  }
  return skills;
}

export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get('window') ?? '24h';
  const window: Window = WINDOW_KEYS.includes(param as Window)
    ? (param as Window)
    : '24h';

  const cached = cache.get(window);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const cutoff = window === 'all' ? -Infinity : Date.now() / 1000 - WINDOWS[window] / 1000;
  const jobs = listJobs().filter((j) => j.startedAt >= cutoff);

  const byProject = new Map<string, ProjectUsageRow>();
  const byKind = new Map<string, AgentUsageRow>();
  const bySkill = new Map<string, SkillUsageRow>();
  const promptByKind = new Map<string, { totalBytes: number; samples: number }>();

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
      commitProducingRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      avgPromptBytes: null,
      avgPromptTokens: null,
      promptSamples: 0,
    };
    agentRow.runs += 1;
    if (j.kind === 'commit' && j.exitCode === 0) agentRow.commitProducingRuns += 1;
    agentRow.inputTokens += j.inputTokens ?? 0;
    agentRow.outputTokens += j.outputTokens ?? 0;
    agentRow.cacheReadTokens += j.cacheReadTokens ?? 0;
    agentRow.cacheCreateTokens += j.cacheCreateTokens ?? 0;
    byKind.set(j.kind, agentRow);

    if (j.promptBytes != null && j.promptBytes > 0) {
      const p = promptByKind.get(j.kind) ?? { totalBytes: 0, samples: 0 };
      p.totalBytes += j.promptBytes;
      p.samples += 1;
      promptByKind.set(j.kind, p);
    }

    const runSkills = parseRunSkills(j.skillIds);
    if (runSkills.length > 0) {
      const totalPromptChars = runSkills.reduce((sum, s) => sum + s.promptChars, 0);
      const fallbackShare = 1 / runSkills.length;
      for (const s of runSkills) {
        const share = totalPromptChars > 0 ? s.promptChars / totalPromptChars : fallbackShare;
        const skillRow = bySkill.get(s.id) ?? {
          skillId: s.id,
          skill: s.name,
          runs: 0,
          promptTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        };
        skillRow.runs += 1;
        skillRow.skill = s.name;
        skillRow.promptTokens += Math.round((j.inputTokens ?? 0) * share);
        skillRow.cacheReadTokens += Math.round((j.cacheReadTokens ?? 0) * share);
        bySkill.set(s.id, skillRow);
      }
    }
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
    const p = promptByKind.get(r.kind);
    if (p && p.samples > 0) {
      r.avgPromptBytes = Math.round(p.totalBytes / p.samples);
      r.avgPromptTokens = estimateTokens(r.avgPromptBytes);
      r.promptSamples = p.samples;
    }
    return r;
  });
  agents.sort((a, b) => b.costUsd - a.costUsd);

  const skills = Array.from(bySkill.values()).map((r) => {
    r.costUsd = costUsd({
      inputTokens: r.promptTokens,
      outputTokens: 0,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreateTokens: 0,
    });
    return r;
  });
  skills.sort((a, b) => b.costUsd - a.costUsd);

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
    skills,
  };
  cache.set(window, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(body);
}
