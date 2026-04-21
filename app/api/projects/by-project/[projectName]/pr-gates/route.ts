import { NextResponse } from 'next/server';
import { exec } from '@/lib/shell';
import { resolveProjectPath } from '@/lib/project-data';
import { listJobs, getVerdict } from '@/lib/job-storage';
import { extractCriteria } from '@/lib/start-mark-dod';

export type GateState = 'pass' | 'fail' | 'warn' | 'none';
export type PrGates = {
  issueNumber: number | null;
  tests: GateState;
  review: GateState;
  dod: GateState;
  dodSummary: string | null;
};

// Parse "Closes #N" / "Fixes #N" (case insensitive) from a PR body — that's
// how we tie a PR back to the acceptance-criteria gate.
function parseLinkedIssue(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = body.match(/\b(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Latest finished job of `kind` linked to this GitHub issue — looks at the
// `gh_issue_number` metadata that issue-driven runs stamp on their jobs.
function latestForIssue(project: string, issueNumber: number, kind: string) {
  return listJobs()
    .filter(j => j.project === project && j.kind === kind && j.ghIssueNumber === issueNumber && j.finishedAt != null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
}

// Fall back to any recent completion of `kind` for the project — used when
// the job wasn't tagged with the issue number (e.g. release pipeline steps
// that chain from a review).
function latestAny(project: string, kind: string) {
  return listJobs()
    .filter(j => j.project === project && j.kind === kind && j.finishedAt != null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
}

async function fetchIssueDod(projPath: string, repo: string, issueNumber: number): Promise<{ state: GateState; summary: string | null }> {
  try {
    const r = await exec('gh', ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'body'], { cwd: projPath, timeout: 10000 });
    if (r.exitCode !== 0) return { state: 'none', summary: null };
    const body = (JSON.parse(r.stdout).body ?? '') as string;
    const unchecked = extractCriteria(body).length;
    const checked = (body.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length;
    const total = checked + unchecked;
    if (total === 0) return { state: 'none', summary: 'no DoD' };
    if (unchecked === 0) return { state: 'pass', summary: `${checked}/${total} DoD` };
    return { state: 'warn', summary: `${checked}/${total} DoD` };
  } catch {
    return { state: 'none', summary: null };
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const url = new URL(req.url);
  const issueParam = url.searchParams.get('issue');
  const prBody = url.searchParams.get('body') ?? '';
  const repo = url.searchParams.get('repo') ?? '';
  const issueNumber = issueParam ? parseInt(issueParam, 10) : parseLinkedIssue(prBody);

  let tests: GateState = 'none';
  let review: GateState = 'none';
  let dod: GateState = 'none';
  let dodSummary: string | null = null;

  if (issueNumber != null && !Number.isNaN(issueNumber)) {
    const testJob = latestForIssue(projectName, issueNumber, 'test') ?? latestAny(projectName, 'test');
    if (testJob) tests = testJob.exitCode === 0 ? 'pass' : 'fail';

    const reviewJob = latestForIssue(projectName, issueNumber, 'review') ?? latestAny(projectName, 'review');
    if (reviewJob) {
      if (reviewJob.exitCode !== 0) review = 'fail';
      else {
        const v = getVerdict(reviewJob);
        if (v === 'LGTM') review = 'pass';
        else if (v === 'NEEDS ATTENTION') review = 'warn';
        else if (v === 'DO NOT SHIP') review = 'fail';
        else review = 'warn';
      }
    }

    if (repo) {
      const d = await fetchIssueDod(projPath, repo, issueNumber);
      dod = d.state;
      dodSummary = d.summary;
    }
  }

  const result: PrGates = { issueNumber: issueNumber ?? null, tests, review, dod, dodSummary };
  return NextResponse.json(result);
}
