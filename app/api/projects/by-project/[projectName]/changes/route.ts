import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
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

// The merge-check `git fetch` is network-bound (~0.5–3s) and previously ran on
// every changes poll for a non-default branch, making the tab feel frozen.
// Cache the merge result per project+default+branch for a short window so rapid
// polls reuse it; the default-branch case still does zero network. Open-PR
// detection stays live because stale PR URLs change the available user action.
// Pinned to globalThis per the codebase singleton pattern (route modules can be
// duplicated across Next.js bundle realms).
const BRANCH_INFO_TTL_MS = 30_000;
declare global {
  var __tamtamChangesBranchInfoCache:
    | Map<string, { branchMerged: boolean; time: number }>
    | undefined;
}

// For renames, numstat writes the path as `dir/{old => new}.ext` or `old => new`.
// Resolve to the new path so lookups against `--name-status` entries succeed.
function canonicalizeRenamePath(p: string): string {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  const arrow = p.match(/^(.+) => (.+)$/);
  if (arrow) return arrow[2];
  return p;
}

// Collapse a porcelain=v2 two-char XY status (X = index/staged vs HEAD, Y =
// worktree vs index) into the single status letter `git diff HEAD --name-status`
// would report: prefer the staged side, falling back to the worktree side.
function xyStatus(xy: string): ChangeStatus {
  const x = xy[0];
  const y = xy[1];
  return ((x && x !== '.' ? x : y) as ChangeStatus);
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

  const [numstat, porcelain] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--numstat'], { timeout: 10000 }),
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

  // Derive the changed-file list + status, the untracked list, and branch/
  // ahead-behind from the single `git status --porcelain=v2 --branch` rather than
  // the former `diff --name-status` + `ls-files --others` pair. Fewer git
  // processes contend on the object store, which is the dominant cost on repos
  // with a large `.git` (each `git diff HEAD`/`status` is ~0.5s there, and
  // running four in parallel thrashes the pack — 2–3s tab loads). Per-file line
  // counts still come from `--numstat` (porcelain carries no add/delete totals);
  // untracked files are still line-counted individually below.
  const files: ChangeFile[] = [];
  const seen = new Set<string>();
  const rawUntracked: string[] = [];
  let branchName: string | null = null;
  let ahead = 0;
  let behind = 0;

  const pushTracked = (status: ChangeStatus, filename: string) => {
    const stats = statMap[filename] ?? { additions: 0, deletions: 0, binary: false };
    files.push({ status, filename, additions: stats.additions, deletions: stats.deletions, binary: stats.binary });
    seen.add(filename);
  };

  for (const line of porcelain.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branchName = line.slice('# branch.head '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // Ordinary change: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`.
      const m = line.match(/^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      if (m) pushTracked(xyStatus(m[1]), m[2]);
    } else if (line.startsWith('2 ')) {
      // Rename/copy: `2 <XY> ... <Xscore> <newPath>\t<origPath>` — keep the new path.
      const m = line.match(/^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      if (m) pushTracked(xyStatus(m[1]), m[2].split('\t')[0]);
    } else if (line.startsWith('u ')) {
      // Unmerged: `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      const m = line.match(/^u .. \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      if (m) pushTracked('U', m[1]);
    } else if (line.startsWith('? ')) {
      rawUntracked.push(line.slice(2));
    }
  }

  const untrackedNames = rawUntracked.filter((s) => s && !seen.has(s));

  const untrackedFiles = await Promise.all(
    untrackedNames.map(async (name): Promise<ChangeFile> => {
      let additions = 0;
      let binary = false;
      try {
        const size = statSync(/*turbopackIgnore: true*/ join(projPath, name)).size;
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

  // Detect default branch via origin/HEAD, falling back to main/master.
  // Inlined to keep this route DB-free so its unit tests can mock fs narrowly.
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
  // Gated behind ahead === 0: if the branch has unpushed commits it can't be
  // fully merged, so skip the 500ms–2s git fetch on the common case.
  // Merge-check is cached per project+branch so rapid changes-tab polls don't
  // re-run a `git fetch` every time. Open-PR detection intentionally remains
  // live per request: a stale cached PR URL can make the UI offer "View PR"
  // after the PR disappeared, or hide a newly-created PR.
  let branchMerged = false;
  let openPrUrl: string | null = null;
  const onFeatureBranch = !!branchName && branchName !== defaultBranch;
  const branchInfoCache = (globalThis.__tamtamChangesBranchInfoCache ??= new Map());
  const branchInfoKey = `${projPath}::${defaultBranch}::${branchName}`;
  if (onFeatureBranch) {
    // Gated on ahead === 0: a branch with unpushed commits can't be fully
    // merged, so skip the 500ms–2s fetch on the common case.
    if (ahead === 0) {
      const cachedBranchInfo = branchInfoCache.get(branchInfoKey);
      if (cachedBranchInfo && Date.now() - cachedBranchInfo.time < BRANCH_INFO_TTL_MS) {
        branchMerged = cachedBranchInfo.branchMerged;
      } else {
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
        branchInfoCache.set(branchInfoKey, { branchMerged, time: Date.now() });
      }
    }
    // Detect an existing open PR so the UI shows "View PR ↗" instead of
    // "Create PR". Network-bound, wrapped in try/catch so a `gh` failure
    // doesn't break the page.
    try {
      const prR = await exec(
        'gh', ['pr', 'list', '--head', branchName as string, '--state', 'open', '--json', 'url', '--limit', '1'],
        { cwd: projPath, timeout: 5000 },
      );
      if (prR.exitCode === 0 && prR.stdout.trim()) {
        const arr = JSON.parse(prR.stdout) as Array<{ url?: string }>;
        if (Array.isArray(arr) && arr[0]?.url) openPrUrl = arr[0].url;
      }
    } catch {
      /* gh unreachable or JSON parse failed — leave openPrUrl null */
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
    openPrUrl,
  });
}

const PULL_STRATEGIES = ['ff-only', 'merge', 'rebase'] as const;
type PullStrategy = (typeof PULL_STRATEGIES)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({}));
  // Strict allow-list: returning 400 on an unknown `strategy` makes the
  // contract explicit and surfaces typos in the client.
  const rawStrategy = body.strategy ?? 'ff-only';
  if (!(PULL_STRATEGIES as readonly string[]).includes(rawStrategy)) {
    return NextResponse.json(
      { detail: `strategy must be one of: ${PULL_STRATEGIES.join(', ')}` },
      { status: 400 },
    );
  }
  const strategy: PullStrategy = rawStrategy;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (statusR.exitCode !== 0) {
    return NextResponse.json({ detail: 'git status failed' }, { status: 422 });
  }
  if (statusR.stdout.trim()) {
    return NextResponse.json(
      { detail: 'Working tree has local changes; commit or stash them before pulling' },
      { status: 409 },
    );
  }

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
