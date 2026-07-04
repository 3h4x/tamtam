// Gated PR merge helper, shared by the HTTP merge route and the agent-action
// orchestrator (the issue-cruncher's `merge-pr` action). Merging goes through
// `gh pr merge`, so GitHub branch protection / required checks still gate it:
// a red or unmergeable PR is refused here, never force-merged. When checks are
// still pending we fall back to `--auto` so the merge lands once they pass.

import { exec } from '@/lib/shared/shell';
import { homedir } from 'os';
import { resolveGhRepo } from '@/lib/github/repo';
import { checkoutDefault } from '@/lib/git/checkout-default';
import { friendlyMergeError, isChecksPendingError } from '@/lib/github/merge-error';

export type MergePrResult =
  // `merged` is true only when the PR actually landed. When required checks are
  // still pending we fall back to `gh pr merge --auto`, which exits 0 by merely
  // ENABLING auto-merge — the PR is not merged yet and may never merge if a
  // check later fails. Callers that resolve a merge-gated HITL must gate on
  // `merged`, not just `ok`, or they'd clear a signal for an unmerged PR.
  | { ok: true; pr: number; repo: string; merged: boolean }
  | { ok: false; status: number; detail: string };

export async function mergePullRequest(opts: {
  project: string;
  projPath: string;
  prNumber: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}): Promise<MergePrResult> {
  const { project, projPath, prNumber } = opts;
  const mergeMethod = opts.mergeMethod ?? 'merge';
  if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    return { ok: false, status: 400, detail: `invalid mergeMethod: ${mergeMethod}` };
  }
  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await resolveGhRepo(project, expanded);
  if (!repo) return { ok: false, status: 422, detail: 'could not determine GitHub repo' };

  const tryMerge = (autoFlag: boolean) => {
    const args = ['pr', 'merge', String(prNumber), '--repo', repo, `--${mergeMethod}`];
    if (autoFlag) args.push('--auto');
    return exec('gh', args, { timeout: 30000 });
  };

  let result = await tryMerge(false);
  // Fall back to --auto (merge-when-green) ONLY for genuinely pending required
  // checks — never for a conflict, which --auto can't resolve and which would
  // otherwise surface a misleading "Auto merge is not allowed". See
  // lib/github/merge-error.ts.
  let autoEnabled = false;
  if (result.exitCode !== 0 && isChecksPendingError(result.stderr)) {
    result = await tryMerge(true);
    autoEnabled = true;
  }
  if (result.exitCode !== 0) {
    return { ok: false, status: 422, detail: friendlyMergeError(prNumber, result.stderr) };
  }
  // Return the working tree to the default branch so a follow-on release
  // (release_after_run) starts clean on default rather than on the just-merged
  // branch. Best-effort — a failure here doesn't undo the merge.
  await checkoutDefault({ project }).catch(() => {});
  // `merged` is false when we only enabled auto-merge (checks pending) — the PR
  // has NOT landed yet, so a HITL for it must stay until it actually merges.
  return { ok: true, pr: prNumber, repo, merged: !autoEnabled };
}
