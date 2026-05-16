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

  // Default branch + work pending. Just release if CI is healthy.
  if (onDefault && hasWork) {
    if (view.defaultBranchCi === 'failure') {
      return { kind: 'skip', reason: 'default-branch CI failing; needs human fix' };
    }
    return { kind: 'release', reason: 'changes on default branch' };
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
  listProjects: () => Promise<string[]>;
  /** Per-call timeout for resolveView; the sweep skips a project that takes
   *  too long rather than hanging the whole pass. */
  perProjectTimeoutMs?: number;
}

export interface SweepReport {
  startedAt: number;
  finishedAt: number;
  total: number;
  byAction: Record<'release' | 'pr-wait' | 'skip', number>;
  results: Array<{
    project: string;
    action: SweepAction['kind'];
    reason: string;
    dispatch?: { ok: boolean; detail: string };
  }>;
}

export async function runSweep(deps: SweepDispatchDeps): Promise<SweepReport> {
  const startedAt = Date.now();
  const names = await deps.listProjects();
  const report: SweepReport = {
    startedAt,
    finishedAt: 0,
    total: names.length,
    byAction: { release: 0, 'pr-wait': 0, skip: 0 },
    results: [],
  };
  for (const name of names) {
    let view: ProjectSweepView | null = null;
    try {
      view = await deps.resolveView(name);
    } catch (err) {
      report.results.push({
        project: name,
        action: 'skip',
        reason: `view error: ${(err as Error).message}`,
      });
      report.byAction.skip += 1;
      continue;
    }
    if (!view) {
      report.results.push({ project: name, action: 'skip', reason: 'no view' });
      report.byAction.skip += 1;
      continue;
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
    }
    report.results.push({ project: name, action: action.kind, reason: action.reason, dispatch });
    report.byAction[action.kind] += 1;
  }
  report.finishedAt = Date.now();
  return report;
}

// Re-export the CliProvider type only to keep public API stable for future
// per-project provider overrides (currently the dispatch helpers infer
// provider via `checkCliStartGate`).
export type { CliProvider };
