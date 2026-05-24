import { findActiveReleaseJob, getJob, listJobs } from '@/lib/jobs/storage';
import type { JobData } from '@/lib/jobs/types';

export interface IssueContext {
  number: number;
  repo: string;
  title: string;
}

export interface PrContext {
  number: number;
  repo: string;
  url?: string;
}

export function issueStamped(
  job: Pick<JobData, 'ghIssueNumber'> | null | undefined,
): job is JobData & { ghIssueNumber: number } {
  return !!job && typeof job.ghIssueNumber === 'number' && Number.isFinite(job.ghIssueNumber);
}

function repoStamped(repo: string | null | undefined): repo is string {
  return typeof repo === 'string' && repo.trim().length > 0;
}

function walkParentChain(job: JobData | null, byId: Map<string, JobData>): JobData[] {
  const out: JobData[] = [];
  const seen = new Set<string>();
  let cursor = job;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    out.push(cursor);
    cursor = cursor.parentJobId ? byId.get(cursor.parentJobId) ?? null : null;
  }
  return out;
}

function latestJob<T extends JobData>(jobs: T[]): T | null {
  // Single-pass max-by-startedAt — called over project-wide job lists that
  // can reach thousands of entries in mature workspaces, so avoid the
  // allocate-copy-sort-take-first idiom.
  let best: T | null = null;
  for (const j of jobs) {
    if (!best || j.startedAt > best.startedAt) best = j;
  }
  return best;
}

function latestPrContext(jobs: Iterable<JobData>, projectName?: string): PrContext | null {
  let bestPr: PrContext | null = null;
  let bestStartedAt = Number.NEGATIVE_INFINITY;
  for (const job of jobs) {
    if (projectName && job.project !== projectName) continue;
    const pr = parsePrContextMeta(job.contextMeta);
    if (!pr) continue;
    if (!bestPr || job.startedAt > bestStartedAt) {
      bestPr = pr;
      bestStartedAt = job.startedAt;
    }
  }
  return bestPr;
}

function recoverIssueRepo(
  projectName: string,
  issueNumber: number,
  jobs: JobData[],
  preferredReleaseId?: string | null,
): string | null {
  let latestOverall: JobData | null = null;
  let latestPreferred: JobData | null = null;
  for (const job of jobs) {
    if (
      job.project !== projectName ||
      job.ghIssueNumber !== issueNumber ||
      !repoStamped(job.ghIssueRepo)
    ) {
      continue;
    }
    if (!latestOverall || job.startedAt > latestOverall.startedAt) {
      latestOverall = job;
    }
    if (
      preferredReleaseId &&
      job.releaseId === preferredReleaseId &&
      (!latestPreferred || job.startedAt > latestPreferred.startedAt)
    ) {
      latestPreferred = job;
    }
  }
  return latestPreferred?.ghIssueRepo ?? latestOverall?.ghIssueRepo ?? null;
}

export function findReleaseScopedIssueJob(
  projectName: string,
  activeRelease: JobData | null = findActiveReleaseJob(projectName),
  jobs: JobData[] = listJobs(),
): JobData | null {
  if (!activeRelease) return null;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const releaseScoped = jobs.filter(
    (job) =>
      job.project === projectName &&
      job.releaseId === activeRelease.id &&
      issueStamped(job),
  );
  const parentChain = walkParentChain(activeRelease, byId).filter(
    (job) => job.project === projectName && issueStamped(job),
  );
  const deduped = new Map<string, JobData>();
  for (const job of [...releaseScoped, ...parentChain]) {
    deduped.set(job.id, job);
  }
  return latestJob([...deduped.values()]);
}

export function findReleaseScopedIssueContext(
  projectName: string,
  activeRelease: JobData | null = findActiveReleaseJob(projectName),
  jobs: JobData[] = listJobs(),
): IssueContext | null {
  const job = findReleaseScopedIssueJob(projectName, activeRelease, jobs);
  if (!job || !issueStamped(job)) return null;
  const repo = repoStamped(job.ghIssueRepo)
    ? job.ghIssueRepo
    : recoverIssueRepo(projectName, job.ghIssueNumber, jobs, activeRelease?.id ?? job.releaseId ?? null);
  if (!repo) return null;
  return {
    number: job.ghIssueNumber,
    repo,
    title: job.ghIssueTitle ?? '',
  };
}

export function parsePrContextMeta(contextMeta: string | null | undefined): PrContext | null {
  if (!contextMeta) return null;
  try {
    const meta = JSON.parse(contextMeta) as { prNumber?: number; prRepo?: string; prUrl?: string };
    if (meta.prNumber && meta.prRepo) {
      return {
        number: meta.prNumber,
        repo: meta.prRepo,
        url: meta.prUrl,
      };
    }
  } catch {}
  return null;
}

export function findReleaseScopedPrContext(
  projectName: string,
  activeRelease: JobData | null = findActiveReleaseJob(projectName),
  jobs: JobData[] = listJobs(),
): PrContext | null {
  if (!activeRelease) return null;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const releaseScoped = jobs.filter(
    (job) => job.project === projectName && job.releaseId === activeRelease.id,
  );
  const parentChain = walkParentChain(activeRelease, byId).filter(
    (job) => job.project === projectName,
  );
  return latestPrContext([...releaseScoped, ...parentChain]);
}

export function findLatestIssueRunContext(
  projectName: string,
  jobs: JobData[] = listJobs(),
): IssueContext | null {
  const job = latestJob(
    jobs.filter((candidate) => candidate.project === projectName && candidate.kind === 'run' && issueStamped(candidate)),
  );
  if (!job || !issueStamped(job)) return null;
  const repo = repoStamped(job.ghIssueRepo)
    ? job.ghIssueRepo
    : recoverIssueRepo(projectName, job.ghIssueNumber, jobs, job.releaseId ?? null);
  if (!repo) return null;
  return {
    number: job.ghIssueNumber,
    repo,
    title: job.ghIssueTitle ?? '',
  };
}

export function findLatestPrContext(
  projectName: string,
  jobs: JobData[] = listJobs(),
): PrContext | null {
  return latestPrContext(jobs, projectName);
}

export function getJobById(jobId: string | null | undefined): JobData | null {
  return jobId ? getJob(jobId) : null;
}
