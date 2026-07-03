// Periodic sweep that drives every tracked project toward "clean on default
// branch". Goal: each project finishes the day with zero uncommitted
// changes, zero unpushed commits, on its default branch, no open
// pipeline-produced PRs.
//
// Triggered by graphile-worker on a 5-minute cadence; can also be called
// directly via `POST /api/sweep`. Decisions are pure (see `decideSweepAction`)
// — the dispatch side is split out so the same logic can be unit-tested
// without touching git, gh, or HTTP.

import type { CliProvider } from '@/lib/usage/cli-providers';

export type SweepAction =
  | { kind: 'release'; reason: string }
  | { kind: 'pr-wait'; prNumber: number; prRepo: string; prUrl: string; reason: string }
  | { kind: 'fix-ci'; reason: string; failedUrl: string | null }
  | { kind: 'skip'; reason: string };

export interface ProjectSweepView {
  /** Project name (DB primary key). */
  name: string;
  /** Local repo path. */
  path: string;
  /** Git branch currently checked out. */
  currentBranch: string;
  /** Repo's default branch (`main` / `master`). */
  defaultBranch: string;
  /** Count of uncommitted files (`git status --short`). */
  uncommittedCount: number;
  /** True when local commits are ahead of the upstream/default branch. */
  hasUnpushedCommits: boolean;
  /** True when a `release` / `test` / `review` / `commit` / `push` / `mark-dod`
   *  / `pr-wait` / `agent:*` / `run` job is currently running for the project. */
  hasActiveJob: boolean;
  /** Default-branch CI conclusion if known. `null` when no CI runs or not
   *  surfaced; `'failure'` blocks all release dispatch. */
  defaultBranchCi: 'success' | 'failure' | 'pending' | null;
  /** The mergeable open PR whose head is `currentBranch`, if any. */
  prOnBranch: {
    number: number;
    repo: string;
    url: string;
    mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    ciConclusion: 'success' | 'failure' | 'pending' | null;
  } | null;
  /** True when the project is paused or archived in the DB. */
  paused: boolean;
  /** Project's `auto_push_enabled` flag. When true, the operator has
   *  explicitly authorized TamTam to push to the default branch without a
   *  manual trigger — the sweep takes that as authorization to self-heal
   *  default-branch worktrees that have accumulated pending work (e.g.
   *  files left uncommitted by a previous agent run that never released).
   *  When false the sweep stays conservative and waits for an explicit
   *  trigger (manual button, agent completion via release-after-run). */
  autoPushEnabled: boolean;
  /** Failing run URL on the default branch when `defaultBranchCi === 'failure'`.
   *  Seeds `gh_status.ci_failed_url` for the auto fix-ci dispatch. Null when CI
   *  is not red or the URL could not be resolved. */
  defaultBranchCiFailedUrl: string | null;
  /** Global `auto_fix_ci_on_red_default_branch` setting. When true AND the
   *  per-project `autoPushEnabled` authorization is present, a red default
   *  branch is self-healed via an auto-dispatched `fix-ci` (bounded in the
   *  runner) instead of being silently skipped. */
  autoFixCiEnabled: boolean;
}

export interface DefaultBranchRun {
  workflowName?: string;
  /** queued | in_progress | completed */
  status?: string;
  /** success | failure | cancelled | timed_out | skipped | neutral | … */
  conclusion?: string | null;
  url?: string;
}

/**
 * Pure: fold `gh run list` runs on the default branch into a single CI verdict
 * plus the first failing run URL. `gh` returns newest-first, so we keep the
 * latest run per workflow (a fresh success supersedes an older failure) and
 * ignore dependency-bot / label noise. Any latest-per-workflow failure wins →
 * `failure` (mirrors `gh-status`'s "any failure" rule). Exported for tests.
 */
export function summarizeDefaultBranchCi(runs: DefaultBranchRun[]): {
  ci: 'success' | 'failure' | 'pending' | null;
  failedUrl: string | null;
} {
  const latest = new Map<string, DefaultBranchRun>();
  for (const r of runs) {
    const name = (r.workflowName ?? '').trim();
    if (/^(dependabot|dependency|label)\b/i.test(name)) continue;
    const key = name || r.url || String(latest.size);
    if (!latest.has(key)) latest.set(key, r);
  }
  const items = [...latest.values()];
  if (items.length === 0) return { ci: null, failedUrl: null };

  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false;
  let failedUrl: string | null = null;
  for (const r of items) {
    const status = (r.status ?? '').toLowerCase();
    if (status && status !== 'completed') { hasPending = true; continue; }
    const conc = (r.conclusion ?? '').toLowerCase();
    if (conc === 'failure' || conc === 'cancelled' || conc === 'timed_out') {
      hasFailure = true;
      if (!failedUrl) failedUrl = r.url ?? null;
    } else if (conc === 'success' || conc === 'skipped' || conc === 'neutral') {
      hasSuccess = true;
    }
  }
  if (hasFailure) return { ci: 'failure', failedUrl };
  if (hasPending) return { ci: 'pending', failedUrl: null };
  if (hasSuccess) return { ci: 'success', failedUrl: null };
  return { ci: null, failedUrl: null };
}

export function decideSweepAction(view: ProjectSweepView): SweepAction {
  if (view.paused) {
    return { kind: 'skip', reason: 'project paused/archived' };
  }
  if (view.hasActiveJob) {
    return { kind: 'skip', reason: 'another job already running for project' };
  }

  const onDefault = view.currentBranch === view.defaultBranch;
  const hasWork = view.uncommittedCount > 0 || view.hasUnpushedCommits;

  // Default branch + work pending. The sweep used to skip this case
  // unconditionally — direct-push-to-default is a high-blast-radius action
  // — but that left auto_push projects stuck whenever a previous agent run
  // produced uncommitted work and the release-after-run trigger didn't
  // fire (per-file attribution gate, lock conflict, rebuild kill). Symptom:
  // dirty files sit on `main` for hours, every new agent attributes them as
  // pre-existing and the gate keeps refusing to ship.
  //
  // When `auto_push_enabled` is on the operator has explicitly authorized
  // direct-to-default pushes, so let the sweep self-heal. When it's off we
  // still wait for an explicit trigger.
  if (onDefault && hasWork) {
    if (!view.autoPushEnabled) {
      return { kind: 'skip', reason: 'changes on default branch — auto_push disabled, needs explicit trigger' };
    }
    return { kind: 'release', reason: 'changes on default branch — auto_push self-healing the worktree' };
  }

  // Non-default branch with local work — release will commit + push +
  // open or update the PR.
  if (!onDefault && hasWork) {
    return { kind: 'release', reason: 'changes on non-default branch' };
  }

  // Non-default branch, clean working tree — close it out via pr-wait if
  // the PR is ready to merge, otherwise skip and let a human decide.
  if (!onDefault && !hasWork) {
    const pr = view.prOnBranch;
    if (!pr) {
      return { kind: 'skip', reason: 'on non-default branch with no work and no open PR — needs human' };
    }
    if (pr.mergeable === 'CONFLICTING') {
      return { kind: 'skip', reason: `PR #${pr.number} has merge conflicts — needs rebase` };
    }
    if (pr.ciConclusion === 'failure') {
      return { kind: 'skip', reason: `PR #${pr.number} CI is failing — needs human fix` };
    }
    if (pr.ciConclusion === 'pending') {
      return { kind: 'skip', reason: `PR #${pr.number} CI still pending` };
    }
    if (pr.mergeable !== 'MERGEABLE') {
      return { kind: 'skip', reason: `PR #${pr.number} mergeable=${pr.mergeable}` };
    }
    return {
      kind: 'pr-wait',
      prNumber: pr.number,
      prRepo: pr.repo,
      prUrl: pr.url,
      reason: `PR #${pr.number} ready to merge`,
    };
  }

  // Default branch, clean. If the default-branch CI is red post-merge and the
  // operator authorized self-healing (global auto_fix_ci_on_red_default_branch
  // + per-project auto_push), auto-dispatch a fix-ci to repair it. The runner
  // bounds this per failing commit so a permanently-broken CI cannot loop; on
  // exhaustion it falls back to the `ci_red` inbox HITL. A clean tree means the
  // only way to turn CI green is to make a NEW fix — exactly what fix-ci does.
  if (view.defaultBranchCi === 'failure' && view.autoFixCiEnabled && view.autoPushEnabled) {
    return { kind: 'fix-ci', reason: 'default-branch CI red — auto fix-ci', failedUrl: view.defaultBranchCiFailedUrl };
  }

  // Default branch, clean — nothing to do.
  return { kind: 'skip', reason: 'already clean on default' };
}

export interface SweepDispatchDeps {
  resolveView: (name: string) => Promise<ProjectSweepView | null>;
  triggerRelease: (name: string, reason: string) => Promise<{ ok: boolean; detail: string }>;
  triggerPrWait: (
    name: string,
    prNumber: number,
    prRepo: string,
    prUrl: string,
    reason: string,
  ) => Promise<{ ok: boolean; detail: string }>;
  triggerFixCi: (name: string, reason: string, failedUrl: string | null) => Promise<{ ok: boolean; detail: string }>;
  listProjects: () => Promise<string[]>;
  /** Per-call timeout for resolveView; the sweep skips a project that takes
   *  too long rather than hanging the whole pass. */
  perProjectTimeoutMs?: number;
}

export interface SweepReport {
  startedAt: number;
  finishedAt: number;
  total: number;
  byAction: Record<'release' | 'pr-wait' | 'fix-ci' | 'skip', number>;
  results: Array<{
    project: string;
    action: SweepAction['kind'];
    reason: string;
    dispatch?: { ok: boolean; detail: string };
  }>;
}

export async function runSweep(deps: SweepDispatchDeps): Promise<SweepReport> {
  const startedAt = Date.now();
  // Respect the global pause: sweep shouldn't start new releases or
  // pr-wait jobs while operators have paused everything.
  try {
    const { isJobsPaused } = await import('@/lib/shared/job-control');
    if (isJobsPaused()) {
      return {
        startedAt,
        finishedAt: Date.now(),
        total: 0,
        byAction: { release: 0, 'pr-wait': 0, 'fix-ci': 0, skip: 0 },
        results: [],
      };
    }
  } catch { /* job-control not available — fall through */ }
  const names = await deps.listProjects();
  const report: SweepReport = {
    startedAt,
    finishedAt: 0,
    total: names.length,
    byAction: { release: 0, 'pr-wait': 0, 'fix-ci': 0, skip: 0 },
    results: [],
  };
  // Fan out per-project work. Each project's resolveView → decide → dispatch
  // chain is independent (per-project lock at the dispatch layer prevents
  // intra-project races; cross-project actions never share state). Sequential
  // awaits made sweep wall time scale linearly with project count — for a
  // fleet of 20 projects with ~4s gh queries each (post iter 118), that was
  // ~80s per sweep. Parallel fan-out collapses that to ~max(per-project).
  const perProject = names.map(async (name): Promise<SweepReport['results'][number]> => {
    let view: ProjectSweepView | null = null;
    try {
      view = await deps.resolveView(name);
    } catch (err) {
      return {
        project: name,
        action: 'skip',
        reason: `view error: ${(err as Error).message}`,
      };
    }
    if (!view) {
      return { project: name, action: 'skip', reason: 'no view' };
    }
    const action = decideSweepAction(view);
    let dispatch: { ok: boolean; detail: string } | undefined;
    if (action.kind === 'release') {
      dispatch = await deps.triggerRelease(name, action.reason);
    } else if (action.kind === 'pr-wait') {
      dispatch = await deps.triggerPrWait(
        name,
        action.prNumber,
        action.prRepo,
        action.prUrl,
        action.reason,
      );
    } else if (action.kind === 'fix-ci') {
      dispatch = await deps.triggerFixCi(name, action.reason, action.failedUrl);
    }
    return { project: name, action: action.kind, reason: action.reason, dispatch };
  });
  // `Promise.all` over the array preserves index order (names → results)
  // so the report stays deterministic for tests and operator readability.
  const settled = await Promise.all(perProject);
  for (const result of settled) {
    report.results.push(result);
    report.byAction[result.action] += 1;
  }
  report.finishedAt = Date.now();
  return report;
}

// Re-export the CliProvider type only to keep public API stable for future
// per-project provider overrides (currently the dispatch helpers infer
// provider via `checkCliStartGate`).
export type { CliProvider };
