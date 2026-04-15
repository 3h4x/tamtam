import { NextRequest, NextResponse } from 'next/server';
import { listJobs, jobToDict, probeJobStatus } from '@/lib/job-storage';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  let jobs = listJobs();
  if (project) {
    jobs = jobs.filter((j) => j.project === project);
  }
  // Probe status for all jobs to update done/running
  for (const j of jobs) {
    await probeJobStatus(j);
  }
  return NextResponse.json({ jobs: jobs.map(jobToDict) });
}
