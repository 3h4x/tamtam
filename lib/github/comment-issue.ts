// Comment on a GitHub issue via the `gh` CLI.
//
// Extracted from `app/api/projects/by-project/[projectName]/issue-comment/route.ts`
// for shared use by the agent-action orchestrator.

import { eq, and } from 'drizzle-orm';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

export interface CommentIssueInput {
  project: string;
  projPath: string;
  number: number;
  body: string;
}

export type CommentIssueResult =
  | { ok: true; number: number; repo: string }
  | { ok: false; status: number; detail: string };

export async function commentIssue(input: CommentIssueInput): Promise<CommentIssueResult> {
  const { project, projPath, number, body } = input;
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, status: 400, detail: 'number required' };
  }
  const text = body.trim();
  if (!text) return { ok: false, status: 400, detail: 'body required' };
  const repo = await resolveGhRepo(project, projPath);
  if (!repo) return { ok: false, status: 422, detail: 'could not determine GitHub repo' };

  const r = await exec(
    'gh',
    ['issue', 'comment', String(number), '--repo', repo, '--body', text],
    { timeout: 15000 },
  );
  if (r.exitCode !== 0) {
    return { ok: false, status: 422, detail: r.stderr.trim() || 'gh issue comment failed' };
  }

  await db.delete(schema.ghIssueDetailCache)
    .where(and(
      eq(schema.ghIssueDetailCache.project, project),
      eq(schema.ghIssueDetailCache.number, number),
    ))
    .execute();

  return { ok: true, number, repo };
}
