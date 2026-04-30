import { NextResponse } from 'next/server';
import { unseenFinished, listJobs, jobToDict } from '@/lib/jobs/job-storage';

export async function GET() {
  const jobs = unseenFinished();
  const running = listJobs().filter(j => j.finishedAt === null);
  return NextResponse.json({
    count: jobs.length,
    jobs: jobs.map(jobToDict),
    runningCount: running.length,
    runningJobs: running.map(jobToDict),
  });
}
