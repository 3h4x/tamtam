// Recovery for an open-PR branch that fell behind the default branch.
//
// When a release opens a PR and a *different* release later merges to the
// default branch touching overlapping files, the open PR goes stale —
// `behind origin/<default>`, often CONFLICTING. `pr-wait` only polls; it never
// rebases. Once it hits its timeout, nobody owns the branch and the PR sits
// stale forever. This handler (dispatched from the stranded-branch reconciler
// for `pr-behind` candidates) rebases the branch onto the freshly-fetched
// default and force-pushes, which clears the stale/conflicting state and
// re-triggers CI. It then re-dispatches `pr-wait` to resume driving the merge.
//
// Safety: scan-time state is only a hint. Right before mutating the repo, the
// handler revalidates the current branch, clean worktree, upstream freshness,
// behind count, and open PR identity. A real textual conflict during the rebase
// is NOT something a background sweep may resolve — it aborts the rebase
// (leaving the worktree clean) and reports `conflict` so a fix agent / human
// can resolve it. The sweep never force-pushes a half-resolved merge.

import { exec } from '@/lib/shared/shell';
import { isRebaseConflict } from '@/lib/pipeline/start-push';
import { createGenericPR } from '@/lib/pipeline/pr-create';
import { launchPrWait } from '@/lib/pipeline/start-pr-wait';

const REBASE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;

export interface PrBehindRebaseResult {
  outcome: 'started' | 'rejected';
  detail: string;
}

async function gitOutput(path: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', path, ...args], { timeout: timeoutMs });
    if (r.exitCode !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

function parseCount(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Discover the open PR for `branch` (number, repo `owner/name`, url) via gh. */
async function discoverOpenPr(
  projPath: string,
  branch: string,
): Promise<{ number: number; repo: string; url: string } | null> {
  try {
    const r = await exec(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,state,headRefName,headRepository,headRepositoryOwner'],
      { cwd: projPath, timeout: 15_000 },
    );
    if (r.exitCode !== 0 || !r.stdout) return null;
    const parsed = JSON.parse(r.stdout) as {
      number?: number;
      url?: string;
      state?: string;
      headRefName?: string;
      headRepository?: { name?: string };
      headRepositoryOwner?: { login?: string };
    };
    const owner = parsed.headRepositoryOwner?.login;
    const name = parsed.headRepository?.name;
    // `gh pr view <branch>` returns the most recent PR for the branch
    // REGARDLESS of state. On a branch whose name was reused after an earlier
    // PR merged (TamTam's `fix/issue-*` branches recur), that is a MERGED PR.
    // Resuming pr-wait on it would observe state=MERGED and falsely report the
    // release shipped while the new commits sit unmerged. Only ever act on an
    // OPEN PR for this exact branch.
    if (parsed.state !== 'OPEN') return null;
    if (parsed.headRefName && parsed.headRefName !== branch) return null;
    if (!parsed.number || !parsed.url || !owner || !name) return null;
    return { number: parsed.number, repo: `${owner}/${name}`, url: parsed.url };
  } catch {
    return null;
  }
}

/**
 * Rebase a behind/stale open-PR branch onto its default branch and force-push,
 * then re-dispatch pr-wait. Returns `started` on a clean rebase + push, or
 * `rejected` (with a reason) on fetch/push failure or a real merge conflict.
 */
export async function rebasePrBehindBranch(candidate: {
  project: string;
  path: string;
  branch: string;
  defaultBranch: string;
}): Promise<PrBehindRebaseResult> {
  const { project, path, branch, defaultBranch } = candidate;

  const fetched = await exec('git', ['-C', path, 'fetch', '--quiet', 'origin', defaultBranch], { timeout: 30_000 });
  if (fetched.exitCode !== 0) {
    return { outcome: 'rejected', detail: `fetch origin/${defaultBranch} failed: ${(fetched.stderr || fetched.stdout || 'unknown').trim().slice(0, 200)}` };
  }

  const currentBranch = await gitOutput(path, ['branch', '--show-current']);
  if (currentBranch !== branch) {
    return { outcome: 'rejected', detail: `branch changed after scan (expected ${branch}, found ${currentBranch || 'detached/unknown'}) — skipping rebase` };
  }

  const status = await gitOutput(path, ['status', '--porcelain']);
  if (status == null || status.length > 0) {
    return { outcome: 'rejected', detail: status == null ? 'could not verify clean worktree — skipping rebase' : 'worktree changed after scan — skipping rebase' };
  }

  const upstreamAhead = parseCount(await gitOutput(path, ['rev-list', '--count', '@{u}..HEAD']));
  if (upstreamAhead == null) {
    return { outcome: 'rejected', detail: 'could not verify upstream freshness — skipping rebase' };
  }
  if (upstreamAhead > 0) {
    return { outcome: 'rejected', detail: `${branch} has ${upstreamAhead} unpushed commit(s) after scan — skipping stale-PR rebase` };
  }

  const behind = parseCount(await gitOutput(path, ['rev-list', '--count', `HEAD..origin/${defaultBranch}`]));
  if (behind == null) {
    return { outcome: 'rejected', detail: `could not verify behind count against origin/${defaultBranch} — skipping rebase` };
  }
  if (behind === 0) {
    return { outcome: 'rejected', detail: `${branch} is no longer behind origin/${defaultBranch} — skipping rebase` };
  }

  // Discover before mutating: if there is no open PR for this exact branch,
  // a background sweep must not rewrite the local or remote branch.
  const pr = await discoverOpenPr(path, branch);
  if (!pr) {
    return { outcome: 'rejected', detail: `no open PR found for ${branch} — skipping rebase and force-push` };
  }

  const rebase = await exec('git', ['-C', path, 'rebase', `origin/${defaultBranch}`], { timeout: REBASE_TIMEOUT_MS });
  if (rebase.exitCode !== 0) {
    const combined = `${rebase.stderr}\n${rebase.stdout}`;
    // Always abort so the worktree returns to a clean state — a background
    // sweep must never leave conflict markers or a half-applied rebase behind.
    await exec('git', ['-C', path, 'rebase', '--abort'], { timeout: 30_000 }).catch(() => {});
    if (isRebaseConflict(combined)) {
      // The branch genuinely conflicts with the default branch — a background
      // sweep can't resolve it. Instead of giving up silently, hand the (already
      // discovered, still-open) PR to a pr-wait: it observes mergeable=CONFLICTING
      // and finalizes with reason 'conflict', which surfaces a
      // pr_needs_manual_merge HITL in the inbox. Merge-or-HITL invariant
      // (CLAUDE.md): a stranded conflict must never be a silent stop.
      const launched = launchPrWait(project, pr.number, pr.repo, pr.url);
      if ('error' in launched) {
        return { outcome: 'rejected', detail: `rebase onto origin/${defaultBranch} hit a merge conflict and pr-wait not started (${launched.error}) — needs a fix agent or manual resolution` };
      }
      return { outcome: 'started', detail: `rebase onto origin/${defaultBranch} hit a merge conflict — dispatched pr-wait #${pr.number} to surface it as a manual-merge HITL` };
    }
    return { outcome: 'rejected', detail: `rebase onto origin/${defaultBranch} failed: ${(rebase.stderr || rebase.stdout || 'unknown').trim().slice(0, 200)}` };
  }

  const push = await exec('git', ['-C', path, 'push', '--force-with-lease', 'origin', branch], { timeout: PUSH_TIMEOUT_MS });
  if (push.exitCode !== 0) {
    return { outcome: 'rejected', detail: `force-push of ${branch} failed: ${(push.stderr || push.stdout || 'unknown').trim().slice(0, 200)}` };
  }

  // Resume the merge drive: the release that originally opened this PR is gone,
  // so dispatch a standalone pr-wait to poll CI and merge once green.
  const launched = launchPrWait(project, pr.number, pr.repo, pr.url);
  if ('error' in launched) {
    return { outcome: 'started', detail: `rebased + force-pushed; pr-wait not started: ${launched.error}` };
  }
  return { outcome: 'started', detail: `rebased ${branch} onto origin/${defaultBranch}, force-pushed, resumed pr-wait #${pr.number}` };
}

/**
 * Resume pr-wait for an up-to-date (behind == 0) open-PR branch whose owning
 * release / pr-wait died. No rebase or push — the branch is already mergeable;
 * it just needs someone to poll CI and merge it. Without this, a green PR whose
 * release crashed after `push` sits OPEN forever (the reconciler used to skip
 * it as "pr-wait's lane" even after pr-wait had exited). Revalidates clean +
 * fully-pushed + not-behind + open-PR identity before dispatching, so a stale
 * scan can never start a wait against the wrong branch state.
 */
export async function resumePrWaitForBranch(candidate: {
  project: string;
  path: string;
  branch: string;
  defaultBranch: string;
}): Promise<PrBehindRebaseResult> {
  const { project, path, branch, defaultBranch } = candidate;

  const currentBranch = await gitOutput(path, ['branch', '--show-current']);
  if (currentBranch !== branch) {
    return { outcome: 'rejected', detail: `branch changed after scan (expected ${branch}, found ${currentBranch || 'detached/unknown'}) — skipping pr-wait resume` };
  }

  const status = await gitOutput(path, ['status', '--porcelain']);
  if (status == null || status.length > 0) {
    return { outcome: 'rejected', detail: status == null ? 'could not verify clean worktree — skipping pr-wait resume' : 'worktree changed after scan — skipping pr-wait resume' };
  }

  const upstreamAhead = parseCount(await gitOutput(path, ['rev-list', '--count', '@{u}..HEAD']));
  if (upstreamAhead == null || upstreamAhead > 0) {
    return { outcome: 'rejected', detail: upstreamAhead == null ? 'could not verify upstream freshness — skipping pr-wait resume' : `${branch} has ${upstreamAhead} unpushed commit(s) after scan — skipping pr-wait resume` };
  }

  const behind = parseCount(await gitOutput(path, ['rev-list', '--count', `HEAD..origin/${defaultBranch}`]));
  if (behind == null) {
    return { outcome: 'rejected', detail: `could not verify behind count against origin/${defaultBranch} — skipping pr-wait resume` };
  }
  if (behind > 0) {
    // Fell behind between scan and now — the rebase path owns this case.
    return { outcome: 'rejected', detail: `${branch} is now ${behind} behind origin/${defaultBranch} — deferring to rebase path` };
  }

  const pr = await discoverOpenPr(path, branch);
  if (!pr) {
    // Green orphan: a clean, fully-pushed, up-to-date feature branch that carries
    // shippable work but has NO open PR. Left alone this is a SILENT STOP —
    // nothing merges and nothing surfaces. Open a PR so the work runs through the
    // normal pr-wait flow (merge or a HITL inbox signal). createGenericPR is
    // idempotent: it reuses an existing OPEN PR and only opens one when genuinely
    // absent, so a busy sweep can't spawn duplicates.
    const created = await createGenericPR(path, () => {});
    if (!created) {
      return { outcome: 'rejected', detail: `no open PR for ${branch} and could not open one — needs a manual PR/merge decision` };
    }
    const createdNum = /\/pull\/(\d+)/.exec(created.prUrl)?.[1];
    if (!createdNum) {
      return { outcome: 'rejected', detail: `opened a PR for ${branch} but could not parse its number: ${created.prUrl}` };
    }
    const launchedNew = launchPrWait(project, Number(createdNum), created.prRepo, created.prUrl);
    if ('error' in launchedNew) {
      return { outcome: 'rejected', detail: `opened PR ${created.prUrl} for ${branch} but pr-wait not started: ${launchedNew.error}` };
    }
    return { outcome: 'started', detail: `opened PR ${created.prUrl} for green-orphan branch ${branch} and started pr-wait` };
  }

  const launched = launchPrWait(project, pr.number, pr.repo, pr.url);
  if ('error' in launched) {
    return { outcome: 'rejected', detail: `pr-wait not started: ${launched.error}` };
  }
  return { outcome: 'started', detail: `resumed pr-wait #${pr.number} for up-to-date open PR on ${branch}` };
}
