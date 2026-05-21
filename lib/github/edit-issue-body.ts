// Read and update the body of a GitHub issue or PR via the `gh` CLI.
//
// Wraps the two operations mark-dod needs:
//   1. fetch current body (via `gh issue/pr view --json body,title,author`)
//   2. write replacement body (via `gh issue/pr edit --body-file <tmp>`)
//
// Extracted from `lib/workflows/phases/mark-dod-impl.ts` so the same code
// path serves both mark-dod (in-process, no sandbox issue) and the agent
// action orchestrator (where the agent emits an `issue-edit-body` action
// from inside a network-blocked sandbox).
//
// Uses --body-file (not --body) for writes because Markdown bodies routinely
// exceed argv length limits and quoting safely on every shell is fragile.

import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from '@/lib/shared/shell';

export type IssueOrPr = 'issue' | 'pr';

export interface ReadIssueBodyInput {
  projPath: string;
  repo: string;
  number: number;
  kind: IssueOrPr;
}

export type ReadIssueBodyResult =
  | { ok: true; body: string; title: string; authorLogin?: string }
  | { ok: false; detail: string };

export async function readIssueBody(input: ReadIssueBodyInput): Promise<ReadIssueBodyResult> {
  const { projPath, repo, number, kind } = input;
  const args = [
    kind === 'pr' ? 'pr' : 'issue',
    'view',
    String(number),
    '--repo', repo,
    '--json', 'body,title,author',
  ];
  const r = await exec('gh', args, { cwd: projPath, timeout: 15000 });
  if (r.exitCode !== 0) {
    return { ok: false, detail: r.stderr.trim() || `gh ${kind} view failed` };
  }
  let parsed: { body?: string; title?: string; author?: { login?: string } } = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* keep parsed empty — caller treats absence of body as no-op */
  }
  return {
    ok: true,
    body: parsed.body ?? '',
    title: parsed.title ?? '',
    authorLogin: parsed.author?.login,
  };
}

export interface WriteIssueBodyInput {
  projPath: string;
  repo: string;
  number: number;
  kind: IssueOrPr;
  body: string;
}

export type WriteIssueBodyResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; detail: string; stdout: string; stderr: string };

export async function writeIssueBody(input: WriteIssueBodyInput): Promise<WriteIssueBodyResult> {
  const { projPath, repo, number, kind, body } = input;
  const tmpFile = join(tmpdir(), `tamtam-${kind}-${number}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(/*turbopackIgnore: true*/ tmpFile, body, { mode: 0o600 });
  try {
    const args = [
      kind === 'pr' ? 'pr' : 'issue',
      'edit',
      String(number),
      '--repo', repo,
      '--body-file', tmpFile,
    ];
    const r = await exec('gh', args, { cwd: projPath, timeout: 15000 });
    if (r.exitCode !== 0) {
      return { ok: false, detail: r.stderr.trim() || `gh ${kind} edit failed`, stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } finally {
    try { unlinkSync(/*turbopackIgnore: true*/ tmpFile); } catch { /* best-effort cleanup */ }
  }
}
