import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { labelIssue, sanitizeLabels } from '@/lib/github/label-issue';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { number?: number; addLabels?: unknown; removeLabels?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: 'invalid JSON' }, { status: 400 }); }

  const issueNumber = Number(body.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'number required' }, { status: 400 });
  }
  const addLabels = sanitizeLabels(body.addLabels);
  const removeLabels = sanitizeLabels(body.removeLabels);

  const result = await labelIssue({
    project: projectName,
    projPath,
    number: issueNumber,
    addLabels,
    removeLabels,
  });
  if (!result.ok) {
    return NextResponse.json({ detail: result.detail }, { status: result.status });
  }
  return NextResponse.json({
    status: 'labeled',
    number: result.number,
    repo: result.repo,
    addLabels: result.addLabels,
    removeLabels: result.removeLabels,
  });
}
