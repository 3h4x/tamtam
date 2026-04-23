import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { statSync } from 'fs';
import { join } from 'path';

type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T';

interface ChangeFile {
  status: ChangeStatus;
  filename: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

// Skip running `git diff --no-index` on huge untracked files; mark binary instead.
const UNTRACKED_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

// For renames, numstat writes the path as `dir/{old => new}.ext` or `old => new`.
// Resolve to the new path so lookups against `--name-status` entries succeed.
function canonicalizeRenamePath(p: string): string {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  const arrow = p.match(/^(.+) => (.+)$/);
  if (arrow) return arrow[2];
  return p;
}

function parseNumstatLine(line: string): { additions: number; deletions: number; binary: boolean; filename: string } | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [addStr, delStr] = parts;
  const filename = canonicalizeRenamePath(parts[parts.length - 1]);
  const binary = addStr === '-' && delStr === '-';
  return {
    additions: binary ? 0 : parseInt(addStr, 10) || 0,
    deletions: binary ? 0 : parseInt(delStr, 10) || 0,
    binary,
    filename,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const [nameStatus, numstat, untracked, porcelain] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--name-status'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--numstat'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain=v2', '--branch'], { timeout: 5000 }),
  ]);

  const statMap: Record<string, { additions: number; deletions: number; binary: boolean }> = {};
  if (numstat.stdout.trim()) {
    for (const line of numstat.stdout.trim().split('\n')) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      const { filename, additions, deletions, binary } = parsed;
      statMap[filename] = { additions, deletions, binary };
    }
  }

  const files: ChangeFile[] = [];
  const seen = new Set<string>();

  if (nameStatus.stdout.trim()) {
    for (const line of nameStatus.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const status = parts[0][0] as ChangeStatus;
      const filename = parts[parts.length - 1];
      const stats = statMap[filename] ?? { additions: 0, deletions: 0, binary: false };
      files.push({
        status,
        filename,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
      });
      seen.add(filename);
    }
  }

  const untrackedNames = untracked.stdout
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s));

  const untrackedFiles = await Promise.all(
    untrackedNames.map(async (name): Promise<ChangeFile> => {
      let additions = 0;
      let binary = false;
      try {
        const size = statSync(join(projPath, name)).size;
        if (size > UNTRACKED_SIZE_LIMIT_BYTES) {
          binary = true;
        } else {
          const diff = await exec(
            'git',
            ['-C', projPath, 'diff', '--no-index', '--numstat', '/dev/null', name],
            { timeout: 5000 }
          );
          const line = diff.stdout.trim().split('\n')[0];
          if (line) {
            const parts = line.split('\t');
            if (parts[0] === '-') binary = true;
            else additions = parseInt(parts[0], 10) || 0;
          }
        }
      } catch {
        /* file may have been removed or unreadable */
      }
      return { status: 'A', filename: name, additions, deletions: 0, binary };
    })
  );

  files.push(...untrackedFiles);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  // Parse branch name and ahead/behind from porcelain v2 (no network)
  const porcelainLines = porcelain.stdout.split('\n');
  const branchName = porcelainLines.find((l) => l.startsWith('# branch.head '))?.slice('# branch.head '.length).trim() || null;
  let behind = 0;
  let ahead = 0;
  const abLine = porcelainLines.find((l) => l.startsWith('# branch.ab '));
  if (abLine) {
    const m = abLine.match(/\+(\d+)\s+-(\d+)/);
    if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
  }

  // Detect default branch via origin/HEAD, falling back to main/master.
  // Inlined here (instead of importing from lib/start-commit) so this route
  // stays DB-free — the route's unit tests mock fs narrowly.
  let defaultBranch = 'master';
  const symR = await exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 3000 });
  const symMatch = symR.exitCode === 0 ? symR.stdout.trim().match(/refs\/remotes\/origin\/(.+)/) : null;
  if (symMatch) {
    defaultBranch = symMatch[1];
  } else {
    const mainR = await exec('git', ['-C', projPath, 'rev-parse', '--verify', 'main'], { timeout: 3000 });
    defaultBranch = mainR.exitCode === 0 ? 'main' : 'master';
  }

  // Detect "stale feature branch": current branch is not the default AND
  // every commit on it is already reachable from origin/<default>. Indicates
  // the PR was merged (manually or otherwise) and the local working copy is
  // stranded on a dead feature branch. A lightweight fetch is required first
  // so the local origin/<default> ref reflects GitHub's current HEAD.
  // Gated behind ?checkMerged=1 because the fetch adds 500ms–2s of network
  // latency on every request — callers opt in only when they have reason to
  // believe the branch may have been merged (e.g. ahead === 0).
  const checkMerged = request.nextUrl.searchParams.get('checkMerged') === '1';
  let branchMerged = false;
  if (checkMerged && branchName && branchName !== defaultBranch) {
    await exec(
      'git',
      ['-C', projPath, 'fetch', '--quiet', 'origin', defaultBranch],
      { timeout: 10000 },
    );
    const aheadR = await exec(
      'git',
      ['-C', projPath, 'rev-list', '--count', `origin/${defaultBranch}..HEAD`],
      { timeout: 5000 },
    );
    if (aheadR.exitCode === 0) {
      const commitsAhead = parseInt(aheadR.stdout.trim(), 10);
      branchMerged = Number.isFinite(commitsAhead) && commitsAhead === 0;
    }
  }

  return NextResponse.json({
    files,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    branch: branchName,
    defaultBranch,
    branchMerged,
    behind,
    ahead,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({}));
  const strategy: 'ff-only' | 'merge' | 'rebase' = body.strategy || 'ff-only';

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const args =
    strategy === 'rebase'
      ? ['pull', '--rebase']
      : strategy === 'merge'
      ? ['pull', '--no-ff']
      : ['pull', '--ff-only'];

  const result = await exec('git', ['-C', projPath, ...args], { timeout: 30000 });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const diverged =
      stderr.includes('Not possible to fast-forward') ||
      stderr.includes('diverged') ||
      stderr.includes('need to specify how to reconcile');
    if (diverged) {
      return NextResponse.json({ detail: 'diverged', diverged: true }, { status: 409 });
    }
    // Strip git hint lines from the error shown to the user
    const clean = stderr
      .split('\n')
      .filter((l) => !l.startsWith('hint:'))
      .join('\n')
      .trim();
    return NextResponse.json({ detail: clean || 'git pull failed' }, { status: 422 });
  }

  return NextResponse.json({ status: 'ok', output: result.stdout.trim() });
}
