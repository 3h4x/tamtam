import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { detectMainBranch } from '@/lib/pipeline/start-commit';
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache';

interface BranchInfo {
  branch: string | null;
  defaultBranch: string;
  commitsAhead: number | null;
}

// This endpoint fires on EVERY project-page mount and again on a 30s poll — it
// drives the header branch label and the Create-PR button (via commitsAhead).
// Each call previously re-spawned 2–3 git processes with NO server cache, so a
// project tab waited 3–5s on git under host contention, and concurrent mounts
// (multiple browser tabs, header + changes tab) stampeded git in parallel.
// Cache the computed result per project (stale-while-revalidate) so only the
// first-ever load per project is slow: later loads return the last value
// immediately and refresh in the background, and concurrent misses single-flight
// one git run. Pinned to globalThis because Next.js duplicates route modules
// across bundle realms. TTL is short (5s) so a checkout / new commit is picked up
// by the background refresh promptly.
declare global {
  var __tamtamBranchInfoCache: Map<string, { value: BranchInfo; time: number }> | undefined;
  var __tamtamBranchInfoInflight: Map<string, Promise<BranchInfo>> | undefined;
}
const BRANCH_INFO_TTL_MS = 5_000;

async function computeBranchInfo(projPath: string): Promise<BranchInfo> {
  const [currentR, defaultBranch] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    detectMainBranch(projPath),
  ]);

  const branch = currentR.stdout.trim() || null;

  // commitsAhead: how many commits the current branch has that aren't
  // reachable from origin/<defaultBranch>. 0 means there's nothing for
  // `gh pr create` to PR, which would fail with "No commits between
  // base and head". The UI uses this to disable Create PR with a clear
  // tooltip instead of relying on the user to interpret a 500.
  // No `git fetch` here — this endpoint is polled every 30s and a network
  // round-trip per poll is too expensive. Stale local origin/<default>
  // can produce a false enabled state, which then surfaces the same
  // gh error as before — no regression vs. today.
  let commitsAhead: number | null = null;
  if (branch && branch !== defaultBranch) {
    const aheadR = await exec(
      'git',
      ['-C', projPath, 'rev-list', '--count', `origin/${defaultBranch}..HEAD`],
      { timeout: 5000 },
    );
    if (aheadR.exitCode === 0) {
      const n = parseInt(aheadR.stdout.trim(), 10);
      if (Number.isFinite(n)) commitsAhead = n;
    }
  }

  return { branch, defaultBranch, commitsAhead };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const store: SwrStore<BranchInfo> = {
    cache: (globalThis.__tamtamBranchInfoCache ??= new Map()),
    inflight: (globalThis.__tamtamBranchInfoInflight ??= new Map()),
  };
  const info = await swrGet(store, projectName, BRANCH_INFO_TTL_MS, () => computeBranchInfo(projPath));
  return NextResponse.json(info);
}
