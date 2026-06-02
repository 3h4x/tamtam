// Add and/or remove labels on a GitHub issue via the `gh` CLI, creating
// labels as needed.
// Shared helper for routes and internal actions that need label mutation.

import { eq, and } from 'drizzle-orm';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

const DEFAULT_LABEL_COLOR = 'FBCA04';
const LABEL_NAME_RE = /^[a-zA-Z0-9._:\-/ ]{1,50}$/;

export function sanitizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || !LABEL_NAME_RE.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

async function ensureLabelExists(repo: string, label: string): Promise<void> {
  // `gh label create` returns non-zero with "already exists" when the label
  // is present. Swallow that case; surface any other failure to the caller.
  const r = await exec(
    'gh',
    ['label', 'create', label, '--repo', repo, '--color', DEFAULT_LABEL_COLOR],
    { timeout: 10000 },
  );
  if (r.exitCode === 0) return;
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (text.includes('already exists')) return;
  throw new Error(`gh label create ${label}: ${r.stderr.trim() || 'unknown error'}`);
}

export interface LabelIssueInput {
  project: string;
  projPath: string;
  number: number;
  addLabels: string[];
  removeLabels: string[];
}

export type LabelIssueResult =
  | { ok: true; number: number; repo: string; addLabels: string[]; removeLabels: string[] }
  | { ok: false; status: number; detail: string };

export async function labelIssue(input: LabelIssueInput): Promise<LabelIssueResult> {
  const { project, projPath, number } = input;
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, status: 400, detail: 'number required' };
  }
  const addLabels = sanitizeLabels(input.addLabels);
  const removeLabels = sanitizeLabels(input.removeLabels);
  if (!addLabels.length && !removeLabels.length) {
    return { ok: false, status: 400, detail: 'addLabels or removeLabels required' };
  }

  const repo = await resolveGhRepo(project, projPath);
  if (!repo) return { ok: false, status: 422, detail: 'could not determine GitHub repo' };

  const labelResults = await Promise.allSettled(
    addLabels.map((label) => ensureLabelExists(repo, label)),
  );
  for (const r of labelResults) {
    if (r.status === 'rejected') {
      const e = r.reason;
      return { ok: false, status: 422, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  const args = ['issue', 'edit', String(number), '--repo', repo];
  if (addLabels.length) args.push('--add-label', addLabels.join(','));
  if (removeLabels.length) args.push('--remove-label', removeLabels.join(','));

  const r = await exec('gh', args, { timeout: 15000 });
  if (r.exitCode !== 0) {
    return { ok: false, status: 422, detail: r.stderr.trim() || 'gh issue edit failed' };
  }

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

  return { ok: true, number, repo, addLabels, removeLabels };
}
