import { NextRequest, NextResponse } from 'next/server';
import { listJobs, jobToDict, probeJobStatus } from '@/lib/job-storage';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const limitParam = request.nextUrl.searchParams.get('limit');

  let jobs = listJobs();
  if (project) {
    jobs = jobs.filter((j) => j.project === project);
  }

  // Sort newest-first before limiting so the limit cuts the oldest entries.
  jobs.sort((a, b) => b.startedAt - a.startedAt);

  // Default limit keeps the response lean; callers can pass limit=0 for all.
  const limit = limitParam !== null ? parseInt(limitParam, 10) : 200;
  if (limit > 0) jobs = jobs.slice(0, limit);

  // Probe all jobs in parallel — sequential awaits here were the main latency
  // source (each running job does a PM2 jlist round-trip, ~50-100 ms each).
  await Promise.all(jobs.map((j) => probeJobStatus(j)));

  return NextResponse.json({ jobs: jobs.map(jobToDict) });
}
