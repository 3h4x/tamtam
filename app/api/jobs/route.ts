import { NextRequest, NextResponse } from 'next/server';
import { listJobs, jobToDict, probeJobStatus } from '@/lib/jobs/job-storage';
import { listPendingReleaseProjects } from '@/lib/pipeline/pending-release';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
  // `limit=0` historically meant "everything"; cap it. Callers that need
  // counts should hit /api/jobs/counts instead.
  if (n === 0) return MAX_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const project = sp.get('project');
  const kind = sp.get('kind');
  const status = sp.get('status'); // 'running' | 'done' | 'aborted'
  const sessionId = sp.get('session_id');
  const hasSession = sp.get('has_session') === '1';
  const offset = Math.max(0, parseInt(sp.get('offset') ?? '0', 10) || 0);
  const limit = parseLimit(sp.get('limit'));

  let jobs = listJobs();
  if (project) jobs = jobs.filter((j) => j.project === project);
  if (kind) jobs = jobs.filter((j) => j.kind === kind);
  if (sessionId) jobs = jobs.filter((j) => j.sessionId === sessionId);
  if (hasSession) jobs = jobs.filter((j) => !!j.sessionId);
  if (status === 'running') {
    jobs = jobs.filter((j) => j.finishedAt === null && j.abortedAt == null);
  } else if (status === 'done') {
    jobs = jobs.filter((j) => j.finishedAt !== null && j.abortedAt == null);
  } else if (status === 'aborted') {
    jobs = jobs.filter((j) => j.abortedAt != null);
  }

  jobs.sort((a, b) => b.startedAt - a.startedAt);
  const total = jobs.length;
  const page = jobs.slice(offset, offset + limit);

  // Probe only rows still marked running. The cache already knows about
  // finished/aborted rows; probing them every poll was a PM2 round-trip per
  // row for nothing.
  const toProbe = page.filter((j) => j.finishedAt === null && j.abortedAt == null);
  await Promise.all(toProbe.map((j) => probeJobStatus(j)));

  const pendingProjects = await listPendingReleaseProjects();

  return NextResponse.json({
    jobs: page.map(jobToDict),
    total,
    offset,
    limit,
    nextOffset: offset + page.length < total ? offset + page.length : null,
    pendingReleaseProjects: project ? pendingProjects.filter((p) => p === project) : pendingProjects,
  });
}
