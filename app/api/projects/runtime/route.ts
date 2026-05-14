import { NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';

// Per-project runtime snapshot used by the projects table on the home page
// and by /api/jobs/* badge consumers. Returns the small set of facts the
// dashboard actually needs — running jobs, the latest review verdict, the
// most recent activity timestamp — without paging through every row.
//
// Previously these were computed client-side from a full 200-row /api/jobs
// fetch. With history > 20k that scaled badly; this endpoint is O(rows in
// memory) but ships only one entry per project.
interface RuntimeEntry {
  hasRunningReview: boolean;
  hasRunningTest: boolean;
  hasRunningRelease: boolean;
  hasRunningPipelineChild: boolean;
  runningCount: number;
  runningKinds: string[];
  runningAgentNames: string[];
  latestVerdict: string | null;
  latestVerdictAt: number | null;
  lastActivityAt: number | null;
  lastJob: {
    id: string;
    kind: string;
    status: 'running' | 'done' | 'aborted';
    exitCode: number | null;
    startedAt: number;
    finishedAt: number | null;
    verdict: string | null;
  } | null;
}

const PIPELINE_CHILD_KINDS = new Set([
  'test',
  'review',
  'fix',
  'fix-ci',
  'fix-push',
  'commit',
  'push',
  'mark-dod',
  'pr-wait',
]);

function emptyEntry(): RuntimeEntry {
  return {
    hasRunningReview: false,
    hasRunningTest: false,
    hasRunningRelease: false,
    hasRunningPipelineChild: false,
    runningCount: 0,
    runningKinds: [],
    runningAgentNames: [],
    latestVerdict: null,
    latestVerdictAt: null,
    lastActivityAt: null,
    lastJob: null,
  };
}

export async function GET() {
  const jobs = listJobs();
  const projects: Record<string, RuntimeEntry> = {};
  // Track the latest finished review per project so we don't have to re-sort
  // after the loop.
  const latestReviewAt: Record<string, number> = {};

  for (const j of jobs) {
    const e = projects[j.project] ?? (projects[j.project] = emptyEntry());

    const ts = Math.max(j.startedAt ?? 0, j.finishedAt ?? 0);
    if (ts > (e.lastActivityAt ?? 0)) {
      e.lastActivityAt = ts;
      e.lastJob = {
        id: j.id,
        kind: j.kind,
        status: j.abortedAt != null ? 'aborted' : j.finishedAt == null ? 'running' : 'done',
        exitCode: j.exitCode ?? null,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt ?? null,
        verdict: j.verdict ?? null,
      };
    }

    const running = j.finishedAt === null && j.abortedAt == null;
    if (running) {
      e.runningCount += 1;
      if (j.kind === 'review') e.hasRunningReview = true;
      if (j.kind === 'test') e.hasRunningTest = true;
      if (j.kind === 'release') e.hasRunningRelease = true;
      if (PIPELINE_CHILD_KINDS.has(j.kind)) e.hasRunningPipelineChild = true;
      if (!e.runningKinds.includes(j.kind)) e.runningKinds.push(j.kind);
      if (j.kind.startsWith('agent:')) {
        const name = j.kind.slice('agent:'.length);
        if (!e.runningAgentNames.includes(name)) e.runningAgentNames.push(name);
      }
      continue;
    }

    if (j.kind === 'review' && j.exitCode === 0 && j.verdict) {
      const finishedAt = j.finishedAt ?? 0;
      if (finishedAt >= (latestReviewAt[j.project] ?? 0)) {
        latestReviewAt[j.project] = finishedAt;
        e.latestVerdict = j.verdict;
        e.latestVerdictAt = finishedAt;
      }
    }
  }

  return NextResponse.json({ projects });
}
