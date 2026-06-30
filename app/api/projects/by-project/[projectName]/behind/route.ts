import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';

interface BehindAhead { behind: number; ahead: number }

// The behind/ahead count needs a `git fetch` (network, ~0.5–5s) to be accurate
// against origin. This endpoint fires on EVERY project-tab mount (badge), so an
// uncached fetch made every tab load wait seconds. Cache the result per project
// with a short TTL — a "N commits behind" badge does not need to be fresher than
// this — and single-flight concurrent misses so the two mount fires (mount +
// poll) share one fetch instead of racing two. Pinned to globalThis because
// Next.js duplicates route modules across bundle realms.
declare global {
  var __tamtamBehindCache: Map<string, { value: BehindAhead; time: number }> | undefined;
  var __tamtamBehindInflight: Map<string, Promise<BehindAhead>> | undefined;
}
const BEHIND_TTL_MS = 60_000;

async function computeBehindAhead(projPath: string): Promise<BehindAhead> {
  // Use light git primitives instead of `git status --porcelain=v2 --branch`.
  // Porcelain walks every tracked file (~100-300 ms on a large dirty repo)
  // when all we need is the current branch's upstream + the ahead/behind
  // count. `rev-parse @{u}` is O(1) and `rev-list --count --left-right`
  // touches only the divergent commits.
  const upstreamR = await exec(
    'git',
    ['-C', projPath, 'rev-parse', '--abbrev-ref', '@{u}'],
    { timeout: 5000 },
  );
  // No upstream tracking branch (detached HEAD, brand-new local branch,
  // missing remote, ...) — nothing to be behind/ahead of. Return zeros so
  // the UI doesn't render a misleading badge.
  if (upstreamR.exitCode !== 0) {
    return { behind: 0, ahead: 0 };
  }
  const upstream = upstreamR.stdout.trim();
  if (!upstream) {
    return { behind: 0, ahead: 0 };
  }

  // Refresh the upstream ref so behind/ahead reflect what's actually on
  // origin. Without this, we'd report the last local fetch state, which
  // goes stale fast when the user pulls/pushes outside TamTam.
  const slash = upstream.indexOf('/');
  const remote = slash > 0 ? upstream.slice(0, slash) : 'origin';
  const upstreamBranch = slash > 0 ? upstream.slice(slash + 1) : upstream;
  await exec(
    'git',
    ['-C', projPath, 'fetch', '--quiet', remote, upstreamBranch],
    { timeout: 10000 },
  );

  // `HEAD...@{u}` in `rev-list --count --left-right` returns
  // `<ahead>\t<behind>` on a single line. Cheaper than re-scanning the
  // worktree just to read porcelain's `# branch.ab` line.
  const countR = await exec(
    'git',
    ['-C', projPath, 'rev-list', '--count', '--left-right', 'HEAD...@{u}'],
    { timeout: 5000 },
  );

  let ahead = 0;
  let behind = 0;
  if (countR.exitCode === 0) {
    const m = countR.stdout.trim().match(/^(\d+)\s+(\d+)/);
    if (m) {
      ahead = parseInt(m[1], 10);
      behind = parseInt(m[2], 10);
    }
  }

  return { behind, ahead };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const cache = (globalThis.__tamtamBehindCache ??= new Map());
  const inflight = (globalThis.__tamtamBehindInflight ??= new Map());

  const hit = cache.get(projectName);
  if (hit && Date.now() - hit.time < BEHIND_TTL_MS) {
    return NextResponse.json(hit.value);
  }

  // Single-flight: the mount fire and a poll can hit the cold cache together —
  // share one git fetch instead of racing two network round-trips.
  let pending = inflight.get(projectName);
  if (!pending) {
    pending = computeBehindAhead(projPath)
      .then((value) => {
        cache.set(projectName, { value, time: Date.now() });
        return value;
      })
      .finally(() => {
        inflight.delete(projectName);
      });
    inflight.set(projectName, pending);
  }

  try {
    return NextResponse.json(await pending);
  } catch {
    // git failed (timeout, missing remote) — don't render a misleading badge.
    return NextResponse.json({ behind: 0, ahead: 0 });
  }
}
