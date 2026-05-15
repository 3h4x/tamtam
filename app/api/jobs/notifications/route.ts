import { NextResponse } from 'next/server';
import { unseenFinished, listJobs, probeJobStatus } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';

const MAX_NOTIFICATION_JOBS = 50;
const MAX_RUNNING_JOBS = 50;

// The notification dropdown renders id, kind, project, status, started/finished
// at, exit_code, verdict, session_id. Everything else (prompt, context_meta,
// log_path, modified_files, work_summary, tokens, cost…) is dead weight on a
// 5-second poll. Ship only what's read.
function notificationJob(job: JobData) {
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
  };
}

export async function GET() {
  const runningCandidates = listJobs().filter(j => j.finishedAt === null);
  await Promise.all(runningCandidates.map(j => probeJobStatus(j)));

  // Per-project superseding: if a project's most recent finished job
  // succeeded in a terminal way, hide older unseen failures for that project
  // — they no longer describe the project's current state and just clutter
  // the bell. Remediation steps like fix are intentionally NOT terminal:
  // a successful fix still needs a follow-up test/review/push.
  // We consider only pipeline-relevant kinds for "supersede" so that, say, a
  // successful agent run doesn't silence an unrelated failed pipeline step
  // (and vice-versa).
  // `fix-ci` is intentionally included here (so a terminal release success can
  // supersede an older fix-ci failure) but is excluded from PIPELINE_CHILD_KINDS
  // and PIPELINE_STEP_KINDS: it is not a standard release-chain step that the
  // orchestrator schedules, and the UI groups it as a top-level entry rather
  // than nesting it under a release card.
  const PIPELINE_LIKE = new Set(['release', 'test', 'review', 'fix', 'fix-ci', 'commit', 'push', 'pr-wait', 'mark-dod']);
  // mark-dod is advisory and can be followed by commit/push, so it must not
  // clear older failures on its own. Neither should intermediate green steps
  // like a passing test or LGTM review: those are step-local successes, not a
  // terminal signal that the overall pipeline is healthy again.
  const GLOBAL_TERMINAL_SUCCESS_KINDS = new Set(['release', 'push', 'pr-wait']);
  const finishedPipelineJobs = listJobs().filter(j => j.finishedAt != null && PIPELINE_LIKE.has(j.kind));

  const isTerminalSuccess = (j: JobData): boolean => {
    if (j.finishedAt == null || j.exitCode !== 0) return false;
    if (j.kind === 'fix' || j.kind === 'fix-ci') return false;
    if (j.kind === 'review') return j.verdict === 'LGTM';
    return true;
  };

  const terminalSuccessSupersedes = (newer: JobData, older: JobData): boolean => {
    if (newer.project !== older.project) return false;
    if ((newer.finishedAt ?? 0) <= (older.finishedAt ?? 0)) return false;
    if (!isTerminalSuccess(newer)) return false;
    return GLOBAL_TERMINAL_SUCCESS_KINDS.has(newer.kind);
  }

  const supersededByGreenSuccess = (j: JobData): boolean => {
    if (!PIPELINE_LIKE.has(j.kind)) return false;
    return finishedPipelineJobs.some(candidate => terminalSuccessSupersedes(candidate, j));
  };

  const jobs = unseenFinished()
    .filter(j => !supersededByGreenSuccess(j))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const running = listJobs()
    .filter(j => j.finishedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt);

  return NextResponse.json({
    count: jobs.length,
    jobs: jobs.slice(0, MAX_NOTIFICATION_JOBS).map(notificationJob),
    runningCount: running.length,
    runningJobs: running.slice(0, MAX_RUNNING_JOBS).map(notificationJob),
  });
}
