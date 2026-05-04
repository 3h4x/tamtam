import { NextRequest, NextResponse } from 'next/server';
import { syncJobToProjectBoard } from '@/lib/github/project-board';
import { getJob } from '@/lib/jobs/job-storage';

export async function POST(_request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: 'Job not found' }, { status: 404 });
  }
  if (job.finishedAt == null) {
    return NextResponse.json({ detail: 'Only finished jobs can be synced manually.' }, { status: 409 });
  }

  try {
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Failed to sync job to GitHub board.';
    const status = detail.startsWith('GitHub board sync ') ? 409 : 502;
    return NextResponse.json({ detail }, { status });
  }
}
