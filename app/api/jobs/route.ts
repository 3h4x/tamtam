import { NextRequest, NextResponse } from 'next/server';
import { listJobs, jobToDict, probeJobStatus } from '@/lib/jobs/job-storage';
import { listPendingReleaseProjects } from '@/lib/pipeline/pending-release';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const limitParam = request.nextUrl.searchParams.get('limit');

  let jobs = listJobs();
  if (project) {
    jobs = jobs.filter((j) => j.project === project);
  }

  // Sort newest-first before limiting so the limit cuts the oldest entries.
  jobs.sort((a, b) => b.startedAt - a.startedAt);
  const total = jobs.length;

  // Default limit keeps the response lean; callers can pass limit=0 for all.
  const limit = limitParam !== null ? parseInt(limitParam, 10) : 200;
  if (limit > 0) jobs = jobs.slice(0, limit);

  // Probe all jobs in parallel — sequential awaits here were the main latency
  // source (each running job does a PM2 jlist round-trip, ~50-100 ms each).
  await Promise.all(jobs.map((j) => probeJobStatus(j)));

  // Surface the pending-release queue so the runs view can render a
  // "release queued" pill on agent rows whose project has a flag set.
  const pendingProjects = listPendingReleaseProjects();

  return NextResponse.json({
    jobs: jobs.map(jobToDict),
    total,
    pendingReleaseProjects: project ? pendingProjects.filter(p => p === project) : pendingProjects,
  });
}
