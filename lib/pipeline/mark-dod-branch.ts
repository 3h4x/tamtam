import { exec } from '@/lib/shared/shell';

// Switch the working tree to the PR's head branch (or the issue's linked
// PR branch) before mark-dod asks Claude to verify acceptance criteria.
// Without this, verification runs against whatever's currently checked out
// (typically master) and every criterion comes back unverified.
//
// Refuses to switch when there are uncommitted changes — never clobbers
// in-progress work. Caller is responsible for restoring the original branch
// (this module returns it for that purpose).
export type EnsureBranchResult =
  | { switched: true; targetBranch: string; originalBranch: string | null; skipped?: undefined }
  | { switched: false; skipped: string; targetBranch?: undefined; originalBranch?: undefined };

export async function ensureBranchForCtx(
  projPath: string,
  ctx: { number: number; repo: string },
  isPr: boolean,
  log: (s: string) => void,
): Promise<EnsureBranchResult> {
  // 1. Find the target branch via gh.
  let targetBranch: string | null = null;
  try {
    if (isPr) {
      const r = await exec('gh', ['pr', 'view', String(ctx.number), '--repo', ctx.repo, '--json', 'headRefName'], { cwd: projPath, timeout: 10000 });
      if (r.exitCode === 0) {
        const { headRefName } = JSON.parse(r.stdout) as { headRefName?: string };
        if (headRefName) targetBranch = headRefName;
      }
    } else {
      // Issue → look for any open PR whose body links it (`closes #N`,
      // `fixes #N`, etc.). gh has no native "PRs that close issue" filter,
      // so query open PRs and scan bodies. Limited to 30 to keep the call
      // cheap on large repos.
      const r = await exec('gh', ['pr', 'list', '--repo', ctx.repo, '--state', 'open', '--limit', '30', '--json', 'number,headRefName,body'], { cwd: projPath, timeout: 10000 });
      if (r.exitCode === 0) {
        const arr = JSON.parse(r.stdout) as Array<{ number: number; headRefName: string; body: string }>;
        const re = new RegExp(`(?:closes?|fix(?:es)?|resolve[sd]?)\\s*#${ctx.number}\\b`, 'i');
        const match = arr.find(p => re.test(p.body));
        if (match?.headRefName) targetBranch = match.headRefName;
      }
    }
  } catch {
    /* gh down or JSON parse error — fall through to "no switch" */
  }
  if (!targetBranch) return { switched: false, skipped: 'no linked PR / head branch found' };

  // 2. What are we on now? Refuse to switch if working tree is dirty.
  // The branch read + dirty check are independent; parallelize. The
  // already-on-target short-circuit is uncommon (mark-dod typically needs
  // to switch to the PR branch), so the extra status call is rarely wasted.
  const [branchR, dirtyR] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
  ]);
  const originalBranch = branchR.stdout.trim() || null;
  if (originalBranch === targetBranch) return { switched: false, skipped: `already on ${targetBranch}` };
  if (dirtyR.exitCode !== 0) {
    return { switched: false, skipped: `could not read working tree state (git status failed) — staying on ${originalBranch ?? 'current branch'}` };
  }
  if (dirtyR.stdout.trim().length > 0) {
    return { switched: false, skipped: `uncommitted changes — staying on ${originalBranch ?? 'current branch'}` };
  }

  // 3. Fetch + checkout. Best-effort: if checkout fails (e.g. branch was
  // deleted remotely between gh query and now), bail back to current.
  await exec('git', ['-C', projPath, 'fetch', 'origin', targetBranch], { timeout: 30000 });
  const coR = await exec('git', ['-C', projPath, 'checkout', targetBranch], { timeout: 10000 });
  if (coR.exitCode !== 0) {
    log(`# could not checkout ${targetBranch}: ${(coR.stderr || coR.stdout).slice(0, 200)}\n`);
    return { switched: false, skipped: `checkout failed — staying on ${originalBranch ?? 'current branch'}` };
  }
  return { switched: true, targetBranch, originalBranch };
}
