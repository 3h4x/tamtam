import { NextResponse } from 'next/server';
import { unseenFinished, listJobs } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';

const MAX_NOTIFICATION_JOBS = 50;
const MAX_RUNNING_JOBS = 50;

// `fix-ci` is intentionally included here (so a terminal release success can
// supersede an older fix-ci failure) but is excluded from PIPELINE_CHILD_KINDS
// and PIPELINE_STEP_KINDS: it is not a standard release-chain step that the
// orchestrator schedules, and the UI groups it as a top-level entry rather
// than nesting it under a release card.
const PIPELINE_LIKE = new Set(['release', 'test', 'review', 'fix', 'fix-ci', 'commit', 'push', 'pr-wait', 'mark-dod', 'soak']);
// mark-dod is advisory and can be followed by commit/push, so it must not
// clear older failures on its own. Neither should intermediate green steps
// like a passing test or LGTM review: those are step-local successes, not a
// terminal signal that the overall pipeline is healthy again.
const GLOBAL_TERMINAL_SUCCESS_KINDS = new Set(['release', 'push', 'pr-wait']);

function isTerminalSuccess(j: JobData): boolean {
  if (j.finishedAt == null || j.exitCode !== 0) return false;
  if (j.kind === 'fix' || j.kind === 'fix-ci') return false;
  if (j.kind === 'review') return j.verdict === 'LGTM';
  return true;
}

// The notification dropdown renders id, kind, project, status, started/finished
// at, exit_code, verdict, session_id. Everything else (prompt, context_meta,
// log_path, modified_files, work_summary, tokens, cost…) is dead weight on a
// 5-second poll. Ship only what's read.
//
// `parent_kind` is the exception: when a running release was triggered by an
// agent, surface the agent's kind so the bell can render the workflow as one
// unit ("agent:improve" badge) instead of the generic "release" wrapper. Same
// merge story as the active-work tile on the Overview page.
function notificationJob(job: JobData, parentKind?: string | null) {
  return {
    id: job.id,
    kind: job.kind,
    project: job.project,
    status: job.abortedAt != null ? 'aborted' : job.finishedAt != null ? 'done' : 'running',
    started_at: job.startedAt,
    finished_at: job.finishedAt ?? null,
    exit_code: job.exitCode ?? null,
    verdict: job.verdict ?? null,
    session_id: job.sessionId ?? null,
    prompt: null,
    user_prompt: null,
    context_meta: null,
    parent_kind: parentKind ?? null,
    parent_job_id: job.parentJobId ?? null,
  };
}

function insertNewestBy<T>(items: T[], item: T, limit: number, valueOf: (item: T) => number): void {
  const value = valueOf(item);
  let index = items.length;
  while (index > 0 && value > valueOf(items[index - 1])) index--;
  if (index >= limit) return;

  items.splice(index, 0, item);
  if (items.length > limit) items.pop();
}

export async function GET() {
  // The 30 s background probe sweep (`runProbeSweep` in
  // instrumentation-node.ts) keeps `finishedAt` fresh on every running row,
  // so this 5 s-polled endpoint avoids a PM2 jlist per running job times five
  // polls per project page.
  //
  // Per-project superseding: if a project's most recent finished job
  // succeeded in a terminal way, hide older unseen failures for that project
  // — they no longer describe the project's current state and just clutter
  // the bell. Remediation steps like fix are intentionally NOT terminal:
  // a successful fix still needs a follow-up test/review/push.
  // We consider only pipeline-relevant kinds for "supersede" so that, say, a
  // successful agent run doesn't silence an unrelated failed pipeline step
  // (and vice-versa).
  const allJobs = listJobs();

  // Pre-compute the most recent terminal-success finish time per project so
  // the supersede check is O(1) per candidate instead of scanning every
  // finished pipeline row each time.
  const latestTerminalSuccessAt: Record<string, number> = {};
  for (const j of allJobs) {
    if (!GLOBAL_TERMINAL_SUCCESS_KINDS.has(j.kind)) continue;
    if (!isTerminalSuccess(j)) continue;
    const finishedAt = j.finishedAt ?? 0;
    if (finishedAt > (latestTerminalSuccessAt[j.project] ?? 0)) {
      latestTerminalSuccessAt[j.project] = finishedAt;
    }
  }

  const supersededByGreenSuccess = (j: JobData): boolean => {
    if (!PIPELINE_LIKE.has(j.kind)) return false;
    const cutoff = latestTerminalSuccessAt[j.project];
    if (cutoff == null) return false;
    return (j.finishedAt ?? 0) < cutoff;
  };

  const jobs: JobData[] = [];
  let notificationCount = 0;
  for (const j of unseenFinished()) {
    if (supersededByGreenSuccess(j)) continue;
    notificationCount++;
    insertNewestBy(jobs, j, MAX_NOTIFICATION_JOBS, job => job.finishedAt ?? 0);
  }

  const running: JobData[] = [];
  let runningCount = 0;
  for (const j of allJobs) {
    if (j.finishedAt !== null) continue;
    runningCount++;
    insertNewestBy(running, j, MAX_RUNNING_JOBS, job => job.startedAt);
  }

  // Build a parent-kind lookup for the running slice. Only releases need
  // this — they're the wrapper kind that benefits from showing its agent.
  // Single-pass id→job Map avoids the O(K*N) scan when many releases run.
  const runningSlice = running.slice(0, MAX_RUNNING_JOBS);
  const releaseNeedsParent = runningSlice.some(r => r.kind === 'release' && r.parentJobId);
  const jobsById = releaseNeedsParent ? new Map(allJobs.map(j => [j.id, j])) : null;
  const parentKindByRunningId: Record<string, string | null> = {};
  if (jobsById) {
    for (const r of runningSlice) {
      if (r.kind !== 'release' || !r.parentJobId) continue;
      parentKindByRunningId[r.id] = jobsById.get(r.parentJobId)?.kind ?? null;
    }
  }

  return NextResponse.json({
    count: notificationCount,
    jobs: jobs.map(j => notificationJob(j)),
    runningCount,
    runningJobs: runningSlice.map(j => notificationJob(j, parentKindByRunningId[j.id])),
  });
}
