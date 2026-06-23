// Reconciler for stranded branches + out-of-sync default branches.
//
// Three scenarios, same sweep:
//
//   1. Stranded `fix/issue-*` branch — the cron task's prereqSkipReason
//      skips fires while the project sits on a non-default branch; the
//      release that should have shipped the branch never finished, so the
//      worktree is stranded with unpushed commits and no in-flight
//      pipeline. We trigger a release through the workflow runtime so the
//      existing orchestrator drives the change to the default remote
//      branch (push direct or via PR, depending on branch context).
//
//   2. Default branch out of sync — local is ahead and/or behind the
//      remote default. We launch a push (which `runPush` extends with an
//      auto-rebase when `behind > 0`) so both pull and push happen in a
//      single shot without going through the full test→review pipeline.
//
//   3. Dirty default branch with release provenance — a pending release or
//      a current failed-commit recovery marker proves the dirty tree is
//      TamTam-owned recovery work. Bare dirty default branches are left
//      alone so human WIP is not released by the background sweep.
//
// Cooldown + attempt cap prevent hammering a project whose release / push
// keeps failing.
//
// Side effect we rely on: getLock() runs selfHealStaleLock, which drops
// the lock when its holder release is finished. That means projects whose
// previous release crashed mid-flight automatically unblock the next time
// this sweep visits them.

import { exec } from '@/lib/shared/shell';
import { listEnabledProjects, isProjectPaused, isProjectArchived } from '@/lib/shared/enabled-projects';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getLock, isLockOwnedByActiveRelease } from '@/lib/pipeline/pipeline-lock';
import { listJobs } from '@/lib/jobs/job-storage';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import { statusHasOnlyCommittedTamtamMetadataPaths } from '@/lib/pipeline/review-scope';

// Per-project cooldown so a release that keeps failing doesn't get
// re-triggered every probe tick (probe = 30s; this is 10 min).
const COOLDOWN_MS = 10 * 60 * 1000;

// In-session attempt cap so a genuinely broken project doesn't burn
// budget. Resets on server restart.
const MAX_ATTEMPTS_PER_PROJECT = 3;

// Branch the cron skipped on must have been quiet (no terminal jobs) for at
// least this long before we touch it — gives the normal release-after-run
// trigger time to fire first.
const QUIET_PERIOD_MS = 3 * 60 * 1000;

const TAMTAM_BRANCH_PATTERN = /^fix\/issue-\d+/;

const lastAttemptAt = new Map<string, number>();
const attemptCount = new Map<string, number>();

export type StrandedKind = 'fix-branch' | 'empty-fix-branch' | 'default-out-of-sync' | 'default-dirty' | 'detached-reattach' | 'pr-behind';

export interface StrandedCandidate {
  project: string;
  path: string;
  branch: string;
  defaultBranch: string;
  kind: StrandedKind;
  ahead: number;
  behind: number;
  reason: string;
}

export interface ReconcileSummary {
  triggered: { project: string; kind: StrandedKind; reason: string; outcome: 'started' | 'queued' | 'rejected'; detail?: string }[];
  skipped: { project: string; reason: string }[];
}

// `git status --porcelain` output has format `XY␣path` per line where the
// XY pair encodes index/worktree state and each char can be a space. Reading
// it through the trimming `gitOutput` would eat the leading space when X is
// unmodified (e.g. ` M file`), shifting the path slice and corrupting the
// `.tamtam/` filter below. Read raw stdout so the prefix stays intact.
async function gitStatusPorcelain(path: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', path, 'status', '--porcelain'], { timeout: 5000 });
    if (r.exitCode !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
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

async function readBranchState(path: string): Promise<{ current: string | null; def: string | null } | null> {
  const current = await gitOutput(path, ['branch', '--show-current']);
  const defRaw = await gitOutput(path, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const def = defRaw ? defRaw.replace(/^refs\/remotes\/origin\//, '') : null;
  if (current == null && def == null) return null;
  return { current: current || null, def };
}

interface DetachedHead {
  head: string;
  /** Worktree has uncommitted changes (auto-checkout would conflict/lose them). */
  isDirty: boolean;
  /** Commits on the detached HEAD not yet on origin/<default> — work to preserve. */
  ahead: number;
}

// A repo can land in a detached HEAD (e.g. a release that checked out a SHA and
// then crashed/aborted before re-attaching). `git branch --show-current` returns
// empty, so the cron's prereqSkipReason and the rest of this sweep skip it — and
// `git push` fails forever with "You are not currently on a branch", so the
// project's releases never ship and it never self-recovers. Detect it so we can
// re-attach to the default branch (preserving any unpushed commits first).
async function readDetachedHead(path: string, def: string): Promise<DetachedHead | null> {
  const head = await gitOutput(path, ['rev-parse', 'HEAD']);
  if (!head) return null; // unborn/empty repo or git error — nothing to reattach
  const status = await gitStatusPorcelain(path);
  const isDirty = !!(status && status.trim().length > 0);
  const aheadRaw = await gitOutput(path, ['rev-list', '--count', `origin/${def}..HEAD`]);
  const ahead = parseInt(aheadRaw ?? '0', 10) || 0;
  return { head, isDirty, ahead };
}

interface ActivityIndex {
  runningAgentProjects: ReadonlySet<string>;
  recentlyActiveProjects: ReadonlySet<string>;
  // Projects with an in-flight pr-wait job. While pr-wait actively polls a
  // PR toward merge, the reconciler must stay out of its lane — only act on a
  // behind/stale PR branch once pr-wait has exited (timeout / checks_failed).
  prWaitActiveProjects: ReadonlySet<string>;
}

// Build the per-sweep activity index in one pass over `listJobs()` instead of
// rescanning the whole job cache per project. For N enabled projects, this
// turns 2N full-list scans into one.
function buildActivityIndex(nowMs: number): ActivityIndex {
  const cutoffSec = (nowMs - QUIET_PERIOD_MS) / 1000;
  const runningAgentProjects = new Set<string>();
  const recentlyActiveProjects = new Set<string>();
  const prWaitActiveProjects = new Set<string>();
  for (const j of listJobs()) {
    if (j.finishedAt === null && isAgentJobKind(j.kind)) {
      runningAgentProjects.add(j.project);
    }
    if (j.finishedAt === null && j.kind === 'pr-wait') {
      prWaitActiveProjects.add(j.project);
    }
    if (typeof j.startedAt === 'number' && j.startedAt > cutoffSec) {
      recentlyActiveProjects.add(j.project);
    }
  }
  return { runningAgentProjects, recentlyActiveProjects, prWaitActiveProjects };
}

async function readAheadBehind(path: string): Promise<{ ahead: number; behind: number } | null> {
  // `status --porcelain=v2 --branch` always reports `# branch.ab +N -M`
  // when an upstream is configured; when there is no upstream the line is
  // absent, which is the signal we use to skip (case 1 is handled via the
  // branch name check, not the ahead/behind here).
  const out = await gitOutput(path, ['status', '--porcelain=v2', '--branch']);
  if (out == null) return null;
  const line = out.split('\n').find((l) => l.startsWith('# branch.ab '));
  if (!line) return null;
  const m = line.match(/\+(\d+)\s+-(\d+)/);
  if (!m) return null;
  return { ahead: parseInt(m[1], 10) || 0, behind: parseInt(m[2], 10) || 0 };
}

async function hasPendingRelease(project: string): Promise<boolean> {
  try {
    const { getPendingRelease } = await import('@/lib/pipeline/pending-release');
    return await getPendingRelease(project);
  } catch {
    return false;
  }
}

async function hasDirtyDefaultReleaseEvidence(
  project: string,
  path: string,
  dirtyStatus: string,
  nowMs: number,
): Promise<boolean> {
  if (await hasPendingRelease(project)) return true;

  try {
    const { hasDefaultDirtyCommitRecoveryMarker } = await import('@/lib/pipeline/commit-recovery-marker');
    return await hasDefaultDirtyCommitRecoveryMarker(project, path, dirtyStatus, nowMs);
  } catch {
    return false;
  }
}

/**
 * Scan enabled projects for branches that need reconciliation: stranded
 * `fix/issue-*` branches (need a release) and default branches out of sync
 * with origin (need pull + push). Pure aside from the lock self-heal
 * triggered by getLock — that heal is intentional and is the whole point of
 * routing lock checks through this sweep.
 */
export async function findStrandedBranches(nowMs: number = Date.now()): Promise<StrandedCandidate[]> {
  const out: StrandedCandidate[] = [];
  const { runningAgentProjects, recentlyActiveProjects, prWaitActiveProjects } = buildActivityIndex(nowMs);
  for (const p of listEnabledProjects()) {
    if (isProjectArchived(p.name) || isProjectPaused(p.name)) continue;
    const path = resolveProjectPath(p.name);
    if (!path) continue;
    const state = await readBranchState(path);
    if (!state || !state.def) continue;
    // Lock self-heal: getLock drops locks held by finished releases. We do
    // this even before the agent/recent-activity check so a stale lock from
    // an aborted release doesn't keep blocking forever.
    const lock = await getLock(p.name);
    if (lock && (await isLockOwnedByActiveRelease(p.name))) continue;
    if (runningAgentProjects.has(p.name)) continue;
    if (recentlyActiveProjects.has(p.name)) continue;

    if (!state.current) {
      // Detached HEAD: re-attach to the default branch so the project can push
      // again. Only act on a CLEAN worktree — a dirty detached checkout would
      // conflict or clobber edits, which a background sweep must never risk.
      // Unpushed commits (if any) are preserved on a recovery branch by the
      // dispatcher before the checkout.
      const det = await readDetachedHead(path, state.def);
      if (det && !det.isDirty) {
        out.push({
          project: p.name,
          path,
          branch: '(detached)',
          defaultBranch: state.def,
          kind: 'detached-reattach',
          ahead: det.ahead,
          behind: 0,
          reason: `detached HEAD at ${det.head.slice(0, 8)}`
            + (det.ahead > 0 ? `, ${det.ahead} unpushed commit(s) to preserve` : '')
            + ` — reattaching to ${state.def}`,
        });
      }
      continue;
    }

    if (state.current !== state.def) {
      if (!TAMTAM_BRANCH_PATTERN.test(state.current)) continue;
      // Distinguish "has unshipped work" (release pipeline can land it)
      // from "empty stranded branch with nothing on top of default"
      // (release rejects "Nothing to release" — the right move is to
      // switch back to default and let the next agent fire start clean).
      const aheadDefault = await gitOutput(path, ['rev-list', '--count', `${state.def}..HEAD`]);
      const aheadOrigin = await gitOutput(path, ['rev-list', '--count', `origin/${state.def}..HEAD`]);
      const localAhead = parseInt(aheadDefault ?? '0', 10) || 0;
      const remoteAhead = parseInt(aheadOrigin ?? '0', 10) || 0;
      // Dirty worktree means there's unshipped work even when no commits
      // sit on top of default yet — startRelease will commit it. Empty +
      // clean is the only state where "checkout default" is safe.
      //
      // Dirty worktree includes `.tamtam/` config files. The release router
      // knows how to commit committed TamTam metadata by bypassing review, so
      // any dirty worktree is recoverable work here. Fully clean empty
      // branches are the only state where "checkout default" is safe.
      const status = await gitStatusPorcelain(path);
      const isDirty = !!(status && status.trim().length > 0);
      // PR-open-awaiting-merge state: branch has commits ahead of default
      // but everything is already pushed (`@{u}..HEAD == 0`) and worktree
      // is clean. The PR exists and is waiting for merge — pipeline's
      // `pr-wait` step owns this state. Triggering another release here is
      // futile: `startRelease` correctly rejects with "Nothing to release"
      // (no dirty, no @{u}..HEAD ahead), and the reconciler would log
      // "rejected" on every sweep. Skip until the PR merges and the branch
      // returns to default.
      if (!isDirty && localAhead > 0) {
        const aheadUpstream = await gitOutput(path, ['rev-list', '--count', '@{u}..HEAD']);
        const upstreamAhead = parseInt(aheadUpstream ?? '0', 10) || 0;
        if (aheadUpstream != null && upstreamAhead === 0) {
          // Fully pushed; an open PR is waiting for merge. While pr-wait is
          // actively polling, stay out of its lane. But pr-wait has a finite
          // timeout — once it exits (timeout / checks_failed) and the default
          // branch advances past this PR (a concurrent release merged), the
          // branch is left behind origin/<default> with nobody to rebase it.
          // It then sits CONFLICTING/stale forever. Detect "behind + no active
          // pr-wait" and emit a pr-behind candidate so the handler rebases it
          // onto the default and force-pushes, clearing the stale state.
          const behindRaw = await gitOutput(path, ['rev-list', '--count', `HEAD..origin/${state.def}`]);
          const behind = parseInt(behindRaw ?? '0', 10) || 0;
          if (behind > 0 && !prWaitActiveProjects.has(p.name)) {
            out.push({
              project: p.name,
              path,
              branch: state.current,
              defaultBranch: state.def,
              kind: 'pr-behind',
              ahead: localAhead,
              behind,
              reason: `open PR on ${state.current} is ${behind} commit(s) behind origin/${state.def} — rebasing to clear stale/conflicting state`,
            });
          }
          continue;
        }
      }
      if (localAhead === 0 && remoteAhead === 0 && !isDirty) {
        out.push({
          project: p.name,
          path,
          branch: state.current,
          defaultBranch: state.def,
          kind: 'empty-fix-branch',
          ahead: 0,
          behind: 0,
          reason: `empty stranded ${state.current}, no commits on top of ${state.def}`,
        });
        continue;
      }
      out.push({
        project: p.name,
        path,
        branch: state.current,
        defaultBranch: state.def,
        kind: 'fix-branch',
        ahead: localAhead || remoteAhead,
        behind: 0,
        reason: isDirty && localAhead === 0 && remoteAhead === 0
          ? `stranded on ${state.current} with dirty worktree, default ${state.def}`
          : `stranded on ${state.current}, default ${state.def}, ${localAhead || remoteAhead} commit(s) ahead`,
      });
      continue;
    }
    // Default branch with a DIRTY worktree is only recoverable when durable
    // TamTam state proves release intent. A bare dirty default branch may be
    // human WIP, so leave it alone instead of auto-committing it from the
    // background probe sweep.
    const dirtyStatus = await gitStatusPorcelain(path);
    if (dirtyStatus && dirtyStatus.trim().length > 0) {
      if (await hasDirtyDefaultReleaseEvidence(p.name, path, dirtyStatus, nowMs)) {
        out.push({
          project: p.name,
          path,
          branch: state.current,
          defaultBranch: state.def,
          kind: 'default-dirty',
          ahead: 0,
          behind: 0,
          reason: `default ${state.def} has uncommitted changes (orphaned by an interrupted release)`,
        });
      } else if (statusHasOnlyCommittedTamtamMetadataPaths(dirtyStatus)) {
        // Dirt confined to committed TamTam metadata (`.tamtam/config.yml`,
        // `.tamtam/agents/**`, or `.tamtam/.gitignore`) blocks the
        // branch-freshness gate's rebase and strands the project with no user
        // WIP at risk. Local scratch such as `.tamtam/cache/**` is excluded.
        const ab = await readAheadBehind(path);
        out.push({
          project: p.name,
          path,
          branch: state.current,
          defaultBranch: state.def,
          kind: 'default-dirty',
          ahead: ab?.ahead ?? 0,
          behind: ab?.behind ?? 0,
          reason: `default ${state.def} dirty with TamTam-owned committed metadata only${ab && ab.behind > 0 ? ` (behind ${ab.behind})` : ''} — committing via release to unstrand`,
        });
      }
      // No release evidence means the dirty default branch is human WIP.
      // Do not fall through to default-out-of-sync push recovery: push can
      // run hooks that mutate the worktree, and recovery must not commit or
      // ship ordinary local edits from the background sweep.
      continue;
    }
    const ab = await readAheadBehind(path);
    if (!ab) continue;
    if (ab.ahead === 0 && ab.behind === 0) continue;
    out.push({
      project: p.name,
      path,
      branch: state.current,
      defaultBranch: state.def,
      kind: 'default-out-of-sync',
      ahead: ab.ahead,
      behind: ab.behind,
      reason: `${state.current} ahead=${ab.ahead} behind=${ab.behind}`,
    });
  }
  return out;
}

export async function reconcileStrandedBranches(
  nowMs: number = Date.now(),
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { triggered: [], skipped: [] };
  try {
    const { isJobsPaused } = await import('@/lib/shared/job-control');
    if (isJobsPaused()) return summary;
  } catch {
    /* job-control unavailable — proceed */
  }
  const candidates = await findStrandedBranches(nowMs);
  for (const c of candidates) {
    const last = lastAttemptAt.get(c.project) ?? 0;
    if (nowMs - last < COOLDOWN_MS) {
      summary.skipped.push({ project: c.project, reason: `cooldown (${Math.round((COOLDOWN_MS - (nowMs - last)) / 1000)}s left)` });
      continue;
    }
    const count = attemptCount.get(c.project) ?? 0;
    if (count >= MAX_ATTEMPTS_PER_PROJECT) {
      summary.skipped.push({ project: c.project, reason: `attempt cap (${count}/${MAX_ATTEMPTS_PER_PROJECT})` });
      continue;
    }
    lastAttemptAt.set(c.project, nowMs);
    attemptCount.set(c.project, count + 1);
    try {
      if (c.kind === 'fix-branch' || c.kind === 'default-dirty') {
        // Both need the full release pipeline to commit (then push) the work:
        // a fix-branch has unshipped commits/dirt on a feature branch; a
        // default-dirty has uncommitted changes on the default branch.
        const { start } = await import('workflow/api');
        const { releaseWorkflow } = await import('@/lib/workflows/release');
        const run = await start(releaseWorkflow, [c.project, { queueIfBlocked: true }]);
        const r = await run.returnValue;
        if (!r.ok) {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: r.detail });
          console.log(`[stranded-branch] ${c.project}: rejected — ${r.detail}`);
        } else if ('status' in r && r.status === 'queued') {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'queued', detail: r.message });
          console.log(`[stranded-branch] ${c.project}: queued — ${r.message}`);
        } else {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'started', detail: 'step' in r ? r.step : undefined });
          console.log(`[stranded-branch] ${c.project}: started release at step=${'step' in r ? r.step : '?'}`);
        }
      } else if (c.kind === 'empty-fix-branch') {
        // Branch has nothing on top of default. Switching back to default is
        // the safe cleanup — the next cron fire on this project starts from
        // a clean base. Skip if the worktree turned dirty since the scan
        // (race with concurrent writes) so we don't clobber edits.
        const status = await gitOutput(c.path, ['status', '--porcelain']);
        if (status && status.trim().length > 0) {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: 'worktree became dirty mid-scan — skipping checkout' });
          console.log(`[stranded-branch] ${c.project}: checkout skipped — dirty worktree`);
        } else {
          const co = await exec('git', ['-C', c.path, 'checkout', c.defaultBranch], { timeout: 15000 });
          if (co.exitCode !== 0) {
            const detail = (co.stderr || co.stdout || '').trim().slice(0, 300);
            summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail });
            console.warn(`[stranded-branch] ${c.project}: checkout ${c.defaultBranch} failed — ${detail}`);
          } else {
            // Delete the now-empty local branch so it doesn't recur on the
            // next sweep. `-D` (not -d) because the branch may have an
            // unmerged commit graph relative to default even though no
            // commits are ahead (e.g. squash-merged upstream).
            await exec('git', ['-C', c.path, 'branch', '-D', c.branch], { timeout: 5000 }).catch(() => {});
            summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'started', detail: `checked out ${c.defaultBranch}` });
            console.log(`[stranded-branch] ${c.project}: checked out ${c.defaultBranch} (deleted empty ${c.branch})`);
          }
        }
      } else if (c.kind === 'detached-reattach') {
        // Re-attach a detached HEAD to the default branch so pushes work again.
        // Re-check dirtiness right before the checkout (race guard) and never
        // touch a dirty tree. Preserve any unpushed commits on a recovery
        // branch first so re-attaching can never lose work.
        const status = await gitOutput(c.path, ['status', '--porcelain']);
        if (status && status.trim().length > 0) {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: 'worktree became dirty mid-scan — skipping reattach' });
          console.log(`[stranded-branch] ${c.project}: reattach skipped — dirty worktree`);
        } else {
          const head = await gitOutput(c.path, ['rev-parse', 'HEAD']);
          let recoverBranch: string | null = null;
          if (c.ahead > 0 && head) {
            recoverBranch = `recover/detached-${head.slice(0, 8)}`;
            const br = await exec('git', ['-C', c.path, 'branch', '-f', recoverBranch, head], { timeout: 5000 });
            if (br.exitCode !== 0) {
              summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: `failed to preserve recovery branch: ${(br.stderr || br.stdout || '').trim().slice(0, 200)}` });
              continue;
            }
          }
          const co = await exec('git', ['-C', c.path, 'checkout', c.defaultBranch], { timeout: 15000 });
          if (co.exitCode !== 0) {
            const detail = (co.stderr || co.stdout || '').trim().slice(0, 300);
            summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail });
            console.warn(`[stranded-branch] ${c.project}: reattach checkout ${c.defaultBranch} failed — ${detail}`);
          } else {
            const detail = `reattached to ${c.defaultBranch}` + (recoverBranch ? ` (preserved ${c.ahead} commit(s) on ${recoverBranch})` : '');
            summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'started', detail });
            console.log(`[stranded-branch] ${c.project}: ${detail}`);
          }
        }
      } else if (c.kind === 'pr-behind') {
        // Open-PR branch that fell behind the default branch (pr-wait exited,
        // a concurrent release advanced the default). Rebase onto the default
        // and force-push to clear the stale/conflicting state, then resume
        // pr-wait. A real conflict aborts cleanly and reports — the sweep
        // never force-pushes a half-resolved merge.
        const { rebasePrBehindBranch } = await import('@/lib/jobs/pr-behind-rebase');
        const r = await rebasePrBehindBranch({ project: c.project, path: c.path, branch: c.branch, defaultBranch: c.defaultBranch });
        summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: r.outcome, detail: r.detail });
        console.log(`[stranded-branch] ${c.project}: pr-behind ${r.outcome} — ${r.detail}`);
      } else {
        // default-out-of-sync: skip the full test→review pipeline and run a
        // push (which auto-rebases when behind > 0). Falls back to release
        // if there are uncommitted changes — startPush leaves dirty trees
        // alone, but launchProjectPush rejects with a 409 in that case so
        // we keep telemetry consistent.
        const { launchProjectPush } = await import('@/lib/pipeline/start-push');
        const r = await launchProjectPush(c.project);
        if ('error' in r) {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: r.error });
          console.log(`[stranded-branch] ${c.project}: push rejected — ${r.error}`);
        } else {
          summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'started', detail: r.jobId });
          console.log(`[stranded-branch] ${c.project}: started push job=${r.jobId} (ahead=${c.ahead}, behind=${c.behind})`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.triggered.push({ project: c.project, kind: c.kind, reason: c.reason, outcome: 'rejected', detail: msg });
      console.warn(`[stranded-branch] ${c.project}: dispatch threw — ${msg}`);
    }
  }
  return summary;
}

/** Test-only: clear attempt history so cases stay isolated. */
export function _resetStrandedBranchAttemptsForTest(): void {
  lastAttemptAt.clear();
  attemptCount.clear();
}
