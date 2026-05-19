import { NextRequest, NextResponse } from 'next/server';
import { listJobs, jobToListDict, probeJobStatus } from '@/lib/jobs/job-storage';
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

  // Merge agent run + downstream release into one visual workflow: if a
  // release in the page points at a parent agent that's been paginated out,
  // hydrate the parent and ship it alongside the page. Without this, the
  // run-list nesting logic in components/project-runs/utils.ts can't link
  // them and the release renders as a standalone "WANTED" card — which the
  // user sees as the release pipeline being a "separate step" from the
  // agent run that triggered it. Synthetic attachments don't count toward
  // pagination math; clients dedupe by id.
  const pageIds = new Set(page.map((j) => j.id));
  const attachments: typeof page = [];
  const seenAttachmentIds = new Set<string>();
  for (const j of page) {
    if (j.kind !== 'release') continue;
    const parentId = j.parentJobId;
    if (!parentId || pageIds.has(parentId) || seenAttachmentIds.has(parentId)) continue;
    const parent = jobs.find((p) => p.id === parentId);
    if (parent) {
      attachments.push(parent);
      seenAttachmentIds.add(parent.id);
    }
  }

  const pendingProjects = await listPendingReleaseProjects();

  return NextResponse.json({
    jobs: [...page, ...attachments].map(jobToListDict),
    total,
    offset,
    limit,
    nextOffset: offset + page.length < total ? offset + page.length : null,
    pendingReleaseProjects: project ? pendingProjects.filter((p) => p === project) : pendingProjects,
  });
}
