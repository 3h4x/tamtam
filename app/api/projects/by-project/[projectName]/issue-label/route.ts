import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { resolveGhRepo } from '@/lib/github/repo';
import { db, schema } from '@/lib/db';

const DEFAULT_LABEL_COLOR = 'FBCA04';
const LABEL_NAME_RE = /^[a-zA-Z0-9._:\-/ ]{1,50}$/;

function sanitizeLabels(raw: unknown): string[] {
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
  if (!addLabels.length && !removeLabels.length) {
    return NextResponse.json({ detail: 'addLabels or removeLabels required' }, { status: 400 });
  }

  const repo = await resolveGhRepo(projectName, projPath);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  for (const label of addLabels) {
    try {
      await ensureLabelExists(repo, label);
    } catch (e) {
      return NextResponse.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 422 });
    }
  }

  const args = ['issue', 'edit', String(issueNumber), '--repo', repo];
  if (addLabels.length) args.push('--add-label', addLabels.join(','));
  if (removeLabels.length) args.push('--remove-label', removeLabels.join(','));

  const r = await exec('gh', args, { timeout: 15000 });
  if (r.exitCode !== 0) {
    return NextResponse.json({ detail: r.stderr.trim() || 'gh issue edit failed' }, { status: 422 });
  }

  await Promise.all([
    db.delete(schema.ghIssueDetailCache)
      .where(and(
        eq(schema.ghIssueDetailCache.project, projectName),
        eq(schema.ghIssueDetailCache.number, issueNumber),
      ))
      .execute(),
    db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .execute(),
  ]);

  return NextResponse.json({ status: 'labeled', number: issueNumber, repo, addLabels, removeLabels });
}
