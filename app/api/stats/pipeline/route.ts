import { NextRequest, NextResponse } from 'next/server';
import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { listJobs, getVerdict } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';
import { getSettings } from '@/lib/shared/config';
import {
  getPushFixAttemptCap,
  getMaxStepIterations,
  getStepWindowSeconds,
} from '@/lib/pipeline/recovery-budget';

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
  prunedMissingVerdict: number;
  total: number;
}

export interface FixLoopStats {
  total: number;
  converged: number;
  hitCap: number;
  avgIterations: number;
}

export interface DurationStats {
  avg: number;
  median: number;
  p95: number;
  count: number;
  avgCostUsd?: number | null;
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
    maxStepIterations: number;
    maxPushFixAttempts: number;
    stepWindowSeconds: number;
  };
}

const MAX_STEP_ITERATIONS = getMaxStepIterations();
const FIX_WINDOW_SECONDS = getStepWindowSeconds();
const RECOVERY_STEP_KINDS = new Set<JobData['kind']>(['fix']);

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

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

function recoveryChildrenOf(release: JobData, recoveryJobs: JobData[]): JobData[] {
  return recoveryJobs.filter(
    (job) =>
      job.project === release.project &&
      (job.releaseId === release.id || job.releaseId == null) &&
      job.startedAt >= release.startedAt &&
      job.startedAt <= (release.finishedAt ?? Infinity),
  );
}

function readReleaseLogTail(release: JobData, tailBytes = 50_000): string {
  if (!release.logPath) return '';
  // Open first, then fstatSync the fd. Previously we statSync'd the path
  // and openSync'd it separately — if PM2 rotated the log between the
  // two syscalls, the open fd pointed at the new file but `start` was
  // computed from the old file's size. Now the size + read both operate
  // on the same open fd (same race-fix as iter 65 / iter 86).
  let fd: number;
  try {
    fd = openSync(/*turbopackIgnore: true*/ release.logPath, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const tail = buffer.toString('utf8', 0, bytesRead);
    if (start === 0) return tail;
    const newlineIdx = tail.indexOf('\n');
    return newlineIdx >= 0 ? tail.slice(newlineIdx + 1) : tail;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

function createReleaseStopReasonReader(): (release: JobData) => string | null {
  const cache = new Map<string, string | null>();
  return (release: JobData): string | null => {
    const key = release.id;
    if (cache.has(key)) return cache.get(key) ?? null;
    const persisted = parseJsonObject(release.contextMeta).releaseStopReason;
    if (typeof persisted === 'string' && persisted.trim()) {
      cache.set(key, persisted);
      return persisted;
    }
    const log = readReleaseLogTail(release);
    if (!log) {
      cache.set(key, null);
      return null;
    }
    const matches = [...log.matchAll(/# release stopped — ([^\n]+)/g)];
    const reason = matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
    cache.set(key, reason);
    return reason;
  };
}

function computeVerdicts(reviewJobs: JobData[]): VerdictDistribution {
  const dist: VerdictDistribution = { lgtm: 0, needsAttention: 0, doNotShip: 0, parseFailed: 0, prunedMissingVerdict: 0, total: reviewJobs.length };
  for (const j of reviewJobs) {
    const v = getVerdict(j);
    if (v === 'LGTM') dist.lgtm++;
    else if (v === 'NEEDS ATTENTION') dist.needsAttention++;
    else if (v === 'DO NOT SHIP') dist.doNotShip++;
    // Distinguish log-pruned-no-verdict (retention gap, improves over time) from
    // genuine parse failures (log available but verdict text not found).
    else if (j.logPruned && !j.verdict) dist.prunedMissingVerdict++;
    else dist.parseFailed++;
  }
  return dist;
}

function computeFixLoop(
  releaseJobs: JobData[],
  recoveryJobs: JobData[],
  getReleaseStopReason: (release: JobData) => string | null,
): FixLoopStats {
  let total = 0, converged = 0, hitCap = 0, totalIterations = 0;
  for (const release of releaseJobs) {
    const children = recoveryChildrenOf(release, recoveryJobs);
    if (children.length === 0) continue;
    total++;
    totalIterations += children.length;
    if (release.exitCode === 0) converged++;
    else if ((getReleaseStopReason(release) ?? '').match(/\b[a-z-]+ cap reached\b/i)) hitCap++;
  }
  return {
    total,
    converged,
    hitCap,
    avgIterations: total > 0 ? Math.round((totalIterations / total) * 10) / 10 : 0,
  };
}

function buildDurationStats(durations: number[], costs: number[]): DurationStats {
  const avgCostUsd = costs.length > 0 ? costs.reduce((s, v) => s + v, 0) / costs.length : null;
  return {
    avg: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    median: percentile(durations, 50),
    p95: percentile(durations, 95),
    count: durations.length,
    avgCostUsd: avgCostUsd != null ? Math.round(avgCostUsd * 10000) / 10000 : null,
  };
}

function computeStepDurations(jobs: JobData[]): Record<string, DurationStats> {
  const STEP_KINDS = ['release', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod'];
  const result: Record<string, DurationStats> = {};

  // For the `release` step, "cost" is the total of all jobs sharing the release_id —
  // the meta-job itself rarely has a cost recorded, but its child steps do.
  const costByReleaseId = new Map<string, number>();
  for (const j of jobs) {
    if (!j.releaseId || j.costUsd == null) continue;
    costByReleaseId.set(j.releaseId, (costByReleaseId.get(j.releaseId) ?? 0) + j.costUsd);
  }

  for (const kind of STEP_KINDS) {
    const finished = jobs.filter((j) => j.kind === kind && j.finishedAt != null);
    const durations = finished.map((j) => jobDurationMs(j)).filter((d): d is number => d != null);
    if (durations.length === 0) continue;

    let costs: number[];
    if (kind === 'release') {
      costs = finished.map((j) => costByReleaseId.get(j.id) ?? (j.costUsd ?? 0)).filter((c) => c > 0);
    } else {
      costs = finished.map((j) => j.costUsd ?? 0).filter((c) => c > 0);
    }

    result[kind] = buildDurationStats(durations, costs);
  }

  // Synthetic `agent` step: the run that triggered each release. Releases store
  // the trigger as `parentJobId` and intentionally do NOT inherit its releaseId,
  // so we have to look it up explicitly. This is typically the most expensive
  // and longest part of the pipeline (the agent doing actual work) — surfacing
  // it is critical for cost analysis.
  const jobById = new Map(jobs.map((j) => [j.id, j] as const));
  const releaseJobs = jobs.filter((j) => j.kind === 'release' && j.finishedAt != null);
  const triggerDurations: number[] = [];
  const triggerCosts: number[] = [];
  for (const r of releaseJobs) {
    if (!r.parentJobId) continue;
    const trigger = jobById.get(r.parentJobId);
    if (!trigger || trigger.finishedAt == null) continue;
    const d = jobDurationMs(trigger);
    if (d != null) triggerDurations.push(d);
    if (trigger.costUsd != null && trigger.costUsd > 0) triggerCosts.push(trigger.costUsd);
  }
  if (triggerDurations.length > 0) {
    result['agent'] = buildDurationStats(triggerDurations, triggerCosts);
  }

  return result;
}

function computeMetrics(
  jobs: JobData[],
  projectFilter: string | null,
): Omit<PipelineResponse, 'window' | 'generatedAt' | 'project' | 'configSnapshot'> {
  const scoped = projectFilter ? jobs.filter((j) => j.project === projectFilter) : jobs;
  const getReleaseStopReason = createReleaseStopReasonReader();

  const reviewJobs = scoped.filter((j) => j.kind === 'review' && j.finishedAt != null && j.exitCode === 0);
  const verdicts = computeVerdicts(reviewJobs);

  const releaseJobs = scoped.filter((j) => j.kind === 'release' && j.finishedAt != null);
  const recoveryJobs = scoped.filter((j) => RECOVERY_STEP_KINDS.has(j.kind));
  const fixLoop = computeFixLoop(releaseJobs, recoveryJobs, getReleaseStopReason);

  const succeeded = releaseJobs.filter((j) => j.exitCode === 0).length;
  const failed = releaseJobs.length - succeeded;
  const pipelineSuccess = {
    succeeded,
    failed,
    total: releaseJobs.length,
    rate: releaseJobs.length > 0 ? succeeded / releaseJobs.length : 0,
  };

  const stepDurations = computeStepDurations(scoped);

  const releaseCostMap = new Map<string, number>();
  for (const j of scoped) {
    if (!j.releaseId || j.costUsd == null) continue;
    releaseCostMap.set(j.releaseId, (releaseCostMap.get(j.releaseId) ?? 0) + j.costUsd);
  }
  // Add the triggering agent/run (parent of release) to both duration and
  // cost — it's outside the releaseId graph but it's the biggest line item
  // of the pipeline. Without it, "avg successful release" hides the most
  // expensive step.
  const scopedById = new Map(scoped.map((j) => [j.id, j] as const));
  const successReleases = releaseJobs.filter((j) => j.exitCode === 0);
  const successDurations = successReleases
    .map((j) => {
      const releaseMs = jobDurationMs(j);
      const trigger = j.parentJobId ? scopedById.get(j.parentJobId) : null;
      const triggerMs = trigger ? jobDurationMs(trigger) : null;
      if (releaseMs == null && triggerMs == null) return null;
      return (releaseMs ?? 0) + (triggerMs ?? 0);
    })
    .filter((d): d is number => d != null && d > 0);
  const successCosts = successReleases
    .map((j) => {
      const releaseCost = releaseCostMap.get(j.id) ?? (j.costUsd ?? 0);
      const trigger = j.parentJobId ? scopedById.get(j.parentJobId) : null;
      const triggerCost = trigger?.costUsd ?? 0;
      return releaseCost + triggerCost;
    })
    .filter((c) => c > 0);
  const mttr: DurationStats | null =
    successDurations.length > 0
      ? {
          avg: Math.round(successDurations.reduce((sum, value) => sum + value, 0) / successDurations.length),
          median: percentile(successDurations, 50),
          p95: percentile(successDurations, 95),
          count: successDurations.length,
          avgCostUsd:
            successCosts.length > 0
              ? Math.round((successCosts.reduce((s, v) => s + v, 0) / successCosts.length) * 10000) / 10000
              : null,
        }
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
      const pRecoveryJobs = pjobs.filter((j) => RECOVERY_STEP_KINDS.has(j.kind));
      const lgtmCount = pReviews.filter((j) => getVerdict(j) === 'LGTM').length;
      const pFixLoop = computeFixLoop(pReleases, pRecoveryJobs, getReleaseStopReason);
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
      maxStepIterations: MAX_STEP_ITERATIONS,
      maxPushFixAttempts: getPushFixAttemptCap(),
      stepWindowSeconds: FIX_WINDOW_SECONDS,
    },
  };

  cache.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(body);
}
