// Close a GitHub issue via the `gh` CLI.
//
// Extracted from `app/api/projects/by-project/[projectName]/issue-close/route.ts`
// so both the HTTP route and the agent-action orchestrator can use the same
// code path. Callers in the agent-action path don't go through HTTP — the
// agent's sandbox blocks localhost, so they invoke this helper directly from
// `markDone` after parsing the agent's emitted action block.

import { eq, and } from 'drizzle-orm';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

export type CloseIssueReason = 'completed' | 'not planned';

export interface CloseIssueInput {
  project: string;
  projPath: string;
  number: number;
  reason: CloseIssueReason;
  comment?: string;
}

export type CloseIssueResult =
  | { ok: true; number: number; reason: CloseIssueReason; repo: string }
  | { ok: false; status: number; detail: string };

export async function closeIssue(input: CloseIssueInput): Promise<CloseIssueResult> {
  const { project, projPath, number, reason, comment } = input;
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, status: 400, detail: 'number required' };
  }
  if (reason !== 'completed' && reason !== 'not planned') {
    return { ok: false, status: 400, detail: 'reason must be one of: completed, not planned' };
  }
  const repo = await resolveGhRepo(project, projPath);
  if (!repo) return { ok: false, status: 422, detail: 'could not determine GitHub repo' };

  const args = ['issue', 'close', String(number), '--repo', repo, '--reason', reason];
  if (comment && comment.trim()) args.push('--comment', comment.trim());

  const r = await exec('gh', args, { timeout: 15000 });
  if (r.exitCode !== 0) {
    return { ok: false, status: 422, detail: r.stderr.trim() || 'gh issue close failed' };
  }

  // Invalidate both detail (for this number) and list (closing changes the open set).
  // Same pattern as the original route — see route handler comment for rationale.
  await Promise.all([
    db.delete(schema.ghIssueDetailCache)
      .where(and(
        eq(schema.ghIssueDetailCache.project, project),
        eq(schema.ghIssueDetailCache.number, number),
      ))
      .execute(),
    db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, project))
      .execute(),
  ]);

  return { ok: true, number, reason, repo };
}
