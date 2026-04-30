import { NextRequest, NextResponse } from 'next/server';
import { launchProjectPush } from '@/lib/pipeline/start-push';
import { startProjectCommit } from '@/lib/pipeline/start-commit';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  // Optional `{ commit: true }` body → run the commit step (Claude generates
  // the message, stages everything, commits). The completion hook then
  // auto-chains to push when `auto_push_enabled` is set on the project, so
  // the new commits land on the existing PR. Used by the "Push to PR" button.
  let commit = false;
  try {
    const text = await request.text();
    if (text) {
      const body = JSON.parse(text) as { commit?: boolean };
      commit = !!body.commit;
    }
  } catch { /* no body or invalid JSON — default push-only */ }

  if (commit) {
    const r = await startProjectCommit(projectName);
    if (!r.ok) {
      return NextResponse.json({ detail: r.detail }, { status: r.status });
    }
    return NextResponse.json({ status: 'started', job_id: r.jobId });
  }

  const result = launchProjectPush(projectName);
  if ('error' in result) {
    return NextResponse.json({ detail: result.error }, { status: result.status ?? 404 });
  }
  return NextResponse.json({ status: 'started', job_id: result.jobId });
}
