import { NextRequest, NextResponse } from 'next/server';
import { listJobs, getVerdict } from '@/lib/job-storage';
import type { JobData } from '@/lib/job-storage';
import { getSettings } from '@/lib/config';

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
} as const;

type Window = keyof typeof WINDOWS;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { body: PipelineResponse; expiresAt: number }>();

export interface VerdictDistribution {
  lgtm: number;
  needsAttention: number;
  doNotShip: number;
  parseFailed: number;
  total: number;
}

export interface FixLoopStats {
  total: number;
  converged: number;
  hitCap: number;
  avgIterations: number;
}

export interface DurationStats {
  median: number;
  p95: number;
  count: number;
}

export interface PipelineProjectRow {
  project: string;
  releases: number;
  successRate: number;
  reviewCount: number;
  lgtmRate: number;
  fixIterationsAvg: number;
  medianReleaseDurationMs: number | null;
}

export interface PipelineResponse {
  window: Window;
  generatedAt: number;
  project: string | null;
  verdicts: VerdictDistribution;
  fixLoop: FixLoopStats;
  pipelineSuccess: { succeeded: number; failed: number; total: number; rate: number };
  stepDurations: Record<string, DurationStats>;
  mttr: DurationStats | null;
  projects: PipelineProjectRow[];
  configSnapshot: {
    verdictRules: string;
    commitStyle: string;
    maxFixIterations: number;
    fixWindowSeconds: number;
  };
}

const MAX_FIX_ITERATIONS = parseInt(process.env.TAMTAM_MAX_FIX_ITERATIONS ?? '', 10) || 3;
const FIX_WINDOW_SECONDS = parseInt(process.env.TAMTAM_FIX_WINDOW_SECONDS ?? '', 10) || 30 * 60;

function jobDurationMs(job: JobData): number | null {
  if (job.durationMs != null && job.durationMs > 0) return job.durationMs;
  if (job.startedAt != null && job.finishedAt != null) {
    const d = (job.finishedAt - job.startedAt) * 1000;
    return d > 0 ? d : null;
  }
  return null;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function fixChildrenOf(release: JobData, fixJobs: JobData[]): JobData[] {
  return fixJobs.filter(
    (fix) =>
      fix.project === release.project &&
      fix.startedAt >= release.startedAt &&
      fix.startedAt <= (release.finishedAt ?? Infinity),
  );
}

function computeVerdicts(reviewJobs: JobData[]): VerdictDistribution {
  const dist: VerdictDistribution = { lgtm: 0, needsAttention: 0, doNotShip: 0, parseFailed: 0, total: reviewJobs.length };
  for (const j of reviewJobs) {
    const v = getVerdict(j);
    if (v === 'LGTM') dist.lgtm++;
    else if (v === 'NEEDS ATTENTION') dist.needsAttention++;
    else if (v === 'DO NOT SHIP') dist.doNotShip++;
    else dist.parseFailed++;
  }
  return dist;
}

function computeFixLoop(releaseJobs: JobData[], fixJobs: JobData[]): FixLoopStats {
  let total = 0, converged = 0, hitCap = 0, totalIterations = 0;
  for (const release of releaseJobs) {
    const children = fixChildrenOf(release, fixJobs);
    if (children.length === 0) continue;
    total++;
    totalIterations += children.length;
    if (release.exitCode === 0) converged++;
    else if (children.length >= MAX_FIX_ITERATIONS) hitCap++;
  }
  return {
    total,
    converged,
    hitCap,
    avgIterations: total > 0 ? Math.round((totalIterations / total) * 10) / 10 : 0,
  };
}

function computeStepDurations(jobs: JobData[]): Record<string, DurationStats> {
  const STEP_KINDS = ['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod'];
  const result: Record<string, DurationStats> = {};
  for (const kind of STEP_KINDS) {
    const durations = jobs
      .filter((j) => j.kind === kind && j.finishedAt != null)
      .map((j) => jobDurationMs(j))
      .filter((d): d is number => d != null);
    if (durations.length > 0) {
      result[kind] = { median: percentile(durations, 50), p95: percentile(durations, 95), count: durations.length };
    }
  }
  return result;
}

function computeMetrics(
  jobs: JobData[],
  projectFilter: string | null,
): Omit<PipelineResponse, 'window' | 'generatedAt' | 'project' | 'configSnapshot'> {
  const scoped = projectFilter ? jobs.filter((j) => j.project === projectFilter) : jobs;

  const reviewJobs = scoped.filter((j) => j.kind === 'review' && j.finishedAt != null && j.exitCode === 0);
  const verdicts = computeVerdicts(reviewJobs);

  const releaseJobs = scoped.filter((j) => j.kind === 'release' && j.finishedAt != null);
  const fixJobs = scoped.filter((j) => j.kind === 'fix');
  const fixLoop = computeFixLoop(releaseJobs, fixJobs);

  const succeeded = releaseJobs.filter((j) => j.exitCode === 0).length;
  const failed = releaseJobs.length - succeeded;
  const pipelineSuccess = {
    succeeded,
    failed,
    total: releaseJobs.length,
    rate: releaseJobs.length > 0 ? succeeded / releaseJobs.length : 0,
  };

  const stepDurations = computeStepDurations(scoped);

  const successDurations = releaseJobs
    .filter((j) => j.exitCode === 0)
    .map((j) => jobDurationMs(j))
    .filter((d): d is number => d != null);
  const mttr: DurationStats | null =
    successDurations.length > 0
      ? { median: percentile(successDurations, 50), p95: percentile(successDurations, 95), count: successDurations.length }
      : null;

  const projects: PipelineProjectRow[] = [];
  if (!projectFilter) {
    const byProject = new Map<string, JobData[]>();
    for (const j of scoped) {
      const arr = byProject.get(j.project) ?? [];
      arr.push(j);
      byProject.set(j.project, arr);
    }
    for (const [project, pjobs] of byProject) {
      const pReleases = pjobs.filter((j) => j.kind === 'release' && j.finishedAt != null);
      if (pReleases.length === 0) continue;
      const pReviews = pjobs.filter((j) => j.kind === 'review' && j.finishedAt != null && j.exitCode === 0);
      const pFix = pjobs.filter((j) => j.kind === 'fix');
      const lgtmCount = pReviews.filter((j) => getVerdict(j) === 'LGTM').length;
      const pFixLoop = computeFixLoop(pReleases, pFix);
      const pDurations = pReleases
        .filter((j) => j.exitCode === 0)
        .map((j) => jobDurationMs(j))
        .filter((d): d is number => d != null);
      projects.push({
        project,
        releases: pReleases.length,
        successRate: pReleases.length > 0 ? pReleases.filter((j) => j.exitCode === 0).length / pReleases.length : 0,
        reviewCount: pReviews.length,
        lgtmRate: pReviews.length > 0 ? lgtmCount / pReviews.length : 0,
        fixIterationsAvg: pFixLoop.avgIterations,
        medianReleaseDurationMs: pDurations.length > 0 ? percentile(pDurations, 50) : null,
      });
    }
    projects.sort((a, b) => b.releases - a.releases);
  }

  return { verdicts, fixLoop, pipelineSuccess, stepDurations, mttr, projects };
}

export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get('window') ?? '30d';
  const window: Window = (Object.keys(WINDOWS) as Window[]).includes(param as Window)
    ? (param as Window)
    : '30d';
  const project = request.nextUrl.searchParams.get('project') ?? null;

  const cacheKey = `${window}:${project ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const cutoff = window === 'all' ? -Infinity : Date.now() / 1000 - WINDOWS[window] / 1000;
  const jobs = listJobs().filter((j) => j.startedAt >= cutoff);

  const settings = getSettings();
  const metrics = computeMetrics(jobs, project);

  const body: PipelineResponse = {
    window,
    generatedAt: Date.now(),
    project,
    ...metrics,
    configSnapshot: {
      verdictRules: settings.review_verdict_rules,
      commitStyle: settings.commit_style,
      maxFixIterations: MAX_FIX_ITERATIONS,
      fixWindowSeconds: FIX_WINDOW_SECONDS,
    },
  };

  cache.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(body);
}
