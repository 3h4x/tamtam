import { NextResponse } from 'next/server';
import { unseenFinished, listJobs, jobToDict, probeJobStatus } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';

const MAX_NOTIFICATION_JOBS = 50;

function notificationJob(job: JobData) {
  const data = jobToDict(job);
  return {
    ...data,
    // Notification polling should stay small and fast. The dropdown only
    // needs identity/status metadata, not full prompts or context payloads.
    prompt: null,
    user_prompt: null,
    context_meta: null,
  };
}

export async function GET() {
  const runningCandidates = listJobs().filter(j => j.finishedAt === null);
  await Promise.all(runningCandidates.map(j => probeJobStatus(j)));

  const jobs = unseenFinished().sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const running = listJobs()
    .filter(j => j.finishedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt);

  return NextResponse.json({
    count: jobs.length,
    jobs: jobs.slice(0, MAX_NOTIFICATION_JOBS).map(notificationJob),
    runningCount: running.length,
    runningJobs: running.map(notificationJob),
  });
}
