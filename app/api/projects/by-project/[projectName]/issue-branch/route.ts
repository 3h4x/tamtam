import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { ensureIssueBranch } from '@/lib/github/issue-branch';

// Given an issue context (number + title), check out a feature branch
// `fix/issue-<n>-<slug>` before Claude starts editing so all interim work
// lands on the branch instead of the default branch. The same logic is
// invoked server-side from the `pick_top=1` issues route so issue-cruncher
// agents never need to run `git checkout` themselves.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { issue_number?: number; issue_title?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const issueNumber = Number(body.issue_number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'issue_number required' }, { status: 400 });
  }
  const title = (body.issue_title ?? '').toString();

  const result = await ensureIssueBranch({ projectName, projPath, issueNumber, issueTitle: title });

  if (result.status === 'pipeline-running') {
    return NextResponse.json(
      {
        detail: `Pipeline is running for ${projectName} — wait for it to finish before switching branches`,
        blockingJobId: result.blockingJobId,
      },
      { status: 409 },
    );
  }
  if (result.status === 'error') {
    return NextResponse.json({ detail: result.detail }, { status: 500 });
  }
  // 'created' / 'reused' / 'already-on-branch' / 'skipped' all return the
  // same shape the previous inline implementation did.
  return NextResponse.json(result);
}
