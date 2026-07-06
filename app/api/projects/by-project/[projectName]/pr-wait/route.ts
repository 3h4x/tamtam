import { NextRequest, NextResponse } from 'next/server';
import { launchPrWait, resolvePrTarget } from '@/lib/pipeline/start-pr-wait';
import { resolveProjectPath } from '@/lib/shared/project-data';

type Body = {
  prNumber?: number;
  prRepo?: string;
  prUrl?: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  let body: Body = {};
  try { body = (await request.json()) as Body; } catch {}

  const prNumber = Number(body.prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'prNumber required' }, { status: 400 });
  }

  let prRepo = body.prRepo;
  let prUrl = body.prUrl;

  if (!prRepo || !prUrl) {
    const projPath = resolveProjectPath(projectName);
    if (!projPath) return NextResponse.json({ error: 'project not found' }, { status: 404 });
    const resolved = await resolvePrTarget(projPath, prNumber);
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 502 });
    }
    prUrl ||= resolved.prUrl;
    prRepo ||= resolved.prRepo;
  }

  if (!prRepo || !prUrl) {
    return NextResponse.json({ error: 'could not resolve prRepo/prUrl' }, { status: 400 });
  }

  const r = launchPrWait(projectName, prNumber, prRepo, prUrl);
  if ('error' in r) {
    if (r.error === 'jobs paused') {
      return NextResponse.json({ error: r.error }, { status: 409 });
    }
    return NextResponse.json({ error: r.error }, { status: 500 });
  }
  return NextResponse.json({ status: 'started', jobId: r.jobId, prNumber, prRepo, prUrl });
}
