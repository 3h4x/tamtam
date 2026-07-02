import { NextResponse } from 'next/server';
import { exec } from '@/lib/shared/shell';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { listJobs } from '@/lib/jobs/job-storage';
import {
  parseLinkedIssue,
  computeDodFromBody,
  computePrGates,
  type GateState,
  type PrGates,
} from '@/lib/github/issue-row-enrichment';

export type { GateState, PrGates };

// Fetch the linked issue body from GitHub so DoD can be computed for a single
// PR out of band. The Issues tab no longer hits this route — it folds gates
// into the (PG-cached) issues response, sourcing DoD from bodies it already
// has — but this endpoint stays for standalone per-PR gate lookups.
async function fetchIssueDod(projPath: string, repo: string, issueNumber: number): Promise<{ state: GateState; summary: string | null }> {
  try {
    const r = await exec('gh', ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'body'], { cwd: projPath, timeout: 10000 });
    if (r.exitCode !== 0) return { state: 'none', summary: null };
    const body = (JSON.parse(r.stdout).body ?? '') as string;
    return computeDodFromBody(body);
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

  let dod: { state: GateState; summary: string | null } = { state: 'none', summary: null };
  if (issueNumber != null && !Number.isNaN(issueNumber) && repo) {
    dod = await fetchIssueDod(projPath, repo, issueNumber);
  }

  const projectJobs =
    issueNumber != null && !Number.isNaN(issueNumber)
      ? listJobs().filter((j) => j.project === projectName)
      : [];
  const result: PrGates = computePrGates(projectJobs, issueNumber != null && !Number.isNaN(issueNumber) ? issueNumber : null, dod);
  return NextResponse.json(result);
}
