import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { resolveGithubRepo } from '@/lib/shared/gh-status';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig } from '@/lib/scheduling/scheduling';

// Close an issue with a verdict comment when a TamTam run determines the
// issue is stale, dead, or otherwise no longer actionable. The findings string
// is posted as a comment first, then the issue is closed (state-reason: not_planned).
//
// Body: { findings: string; reason?: 'stale' | 'duplicate' | 'wontfix' | 'fixed' }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string; number: string }> },
): Promise<NextResponse> {
  const { projectName, number } = await params;
  const issueNumber = Number(number);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ detail: 'invalid issue number' }, { status: 400 });
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  let body: { findings?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }

  const findings = (body.findings ?? '').trim();
  if (!findings) return NextResponse.json({ detail: 'findings required' }, { status: 400 });

  // Validate `reason` against the closed set documented in the function
  // header. Previously the route silently accepted any string and used it
  // verbatim as the verdict-label in the public GitHub comment — a typo
  // like "stalee" would post "## TamTam verdict: STALEE" to the issue,
  // and an attacker-controlled string could splice arbitrary text in
  // upper-case form. The set below mirrors the JSDoc contract.
  const ALLOWED_REASONS = ['stale', 'duplicate', 'wontfix', 'fixed'] as const;
  type AllowedReason = (typeof ALLOWED_REASONS)[number];
  const rawReason = (body.reason ?? 'stale');
  if (typeof rawReason !== 'string') {
    return NextResponse.json({ detail: 'reason must be a string' }, { status: 400 });
  }
  const lowered = rawReason.toLowerCase();
  if (!(ALLOWED_REASONS as readonly string[]).includes(lowered)) {
    return NextResponse.json(
      { detail: `reason must be one of: ${ALLOWED_REASONS.join(', ')}` },
      { status: 400 },
    );
  }
  // Now narrow to the union via the runtime-checked allow-list above.
  const reason = lowered as AllowedReason;
  // GitHub state-reason: only 'not_planned' and 'completed' are accepted via gh CLI;
  // everything except 'fixed' maps to not_planned.
  const stateReason = reason === 'fixed' ? 'completed' : 'not_planned';

  const { projects } = getImproveConfig();
  const projectCfg = Object.values(projects).find((cfg) => cfg.project === projectName);
  const repo = await resolveGithubRepo(projectName, {
    github: projectCfg?.github ?? null,
    path: projPath,
  });

  const verdictLabel = reason.toUpperCase();
  const commentBody =
    `## TamTam verdict: ${verdictLabel}\n\n` +
    `${findings}\n\n` +
    `_Closing this issue based on the analysis above. Reopen if the assumption is wrong._`;

  const commentR = await exec(
    'gh',
    ['issue', 'comment', String(issueNumber), '--repo', repo, '--body', commentBody],
    { cwd: projPath, timeout: 30000 },
  );
  if (commentR.exitCode !== 0) {
    return NextResponse.json(
      { detail: `gh issue comment failed: ${commentR.stderr.trim() || commentR.stdout.trim()}` },
      { status: 502 },
    );
  }

  const closeR = await exec(
    'gh',
    ['issue', 'close', String(issueNumber), '--repo', repo, '--reason', stateReason],
    { cwd: projPath, timeout: 30000 },
  );
  if (closeR.exitCode !== 0) {
    return NextResponse.json(
      { detail: `gh issue close failed: ${closeR.stderr.trim() || closeR.stdout.trim()}` },
      { status: 502 },
    );
  }

  try {
    await db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .execute();
  } catch (e) {
    console.error('[close-stale] failed to invalidate ghIssuesCache:', e);
  }

  return NextResponse.json({
    status: 'closed',
    issue: issueNumber,
    repo,
    reason: stateReason,
    verdict: verdictLabel,
  });
}
