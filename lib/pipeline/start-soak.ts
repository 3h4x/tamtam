// Post-merge soak watcher.
//
// After a PR merges into the default branch, TamTam can keep watching the
// default branch's CI on the merge commit for a configurable window. If a
// run on that commit fails inside the window, TamTam opens a revert PR via
// `git revert <sha>` + `gh pr create`, and — when the project flag
// `auto_revert_enabled` is on — auto-merges the revert.
//
// The watcher is gated by per-project `post_merge_watch_minutes`. Zero or
// missing means "skip soak entirely", which preserves the prior behavior
// where the release ends at PR merge.
//
// This module is split into two layers:
//
//   1. Pure helpers — `classifyDefaultBranchCi`, `revertBranchName`,
//      `buildRevertPrBody`. These have no side effects so unit tests can
//      cover the happy/fail/timeout decision paths without spinning up
//      Postgres, the workflow runtime, or git.
//
//   2. `soakWatcher` — the side-effectful loop that polls `gh run list` on
//      the merge SHA, opens the revert PR on failure, and fires the
//      `post_merge_revert` notification. Driven by the workflow phase in
//      `lib/workflows/phases/soak-phase.ts`.

import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { exec } from '@/lib/shared/shell';
import { createJob, getJob, markDone, updateJob } from '@/lib/jobs/job-storage';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import type { JobData } from '@/lib/jobs/types';

export const SOAK_DEFAULT_POLL_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.TAMTAM_SOAK_POLL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

export interface SoakContextMeta {
  mergeSha: string;
  prRepo: string;
  prNumber: number;
  prUrl: string;
  defaultBranch: string;
  watchMinutes: number;
  autoRevert: boolean;
}

export interface CiRun {
  status: string;
  conclusion: string | null;
  url?: string;
  workflowName?: string;
  databaseId?: number | string;
}

export type SoakCiVerdict =
  | { kind: 'pass' }
  | { kind: 'fail'; failed: CiRun[] }
  | { kind: 'pending' }
  | { kind: 'none' };

/**
 * Pure helper: turn a `gh run list` payload into a soak verdict.
 *
 * Statuses we recognise (mirrors the GitHub Actions REST schema):
 *   - completed + conclusion in success/skipped/neutral → counts as pass
 *   - completed + conclusion in failure/timed_out/cancelled/startup_failure → fail
 *   - anything not completed → pending
 *
 * Empty list → `none`. The caller decides whether to wait or treat that
 * as "no CI configured".
 */
export function classifyDefaultBranchCi(runs: CiRun[]): SoakCiVerdict {
  if (!runs || runs.length === 0) return { kind: 'none' };
  const failed: CiRun[] = [];
  let anyPending = false;
  for (const r of runs) {
    const status = (r.status ?? '').toLowerCase();
    if (status !== 'completed') {
      anyPending = true;
      continue;
    }
    const conc = (r.conclusion ?? '').toLowerCase();
    if (conc === 'success' || conc === 'skipped' || conc === 'neutral') continue;
    failed.push(r);
  }
  if (failed.length > 0) return { kind: 'fail', failed };
  if (anyPending) return { kind: 'pending' };
  return { kind: 'pass' };
}

/**
 * Pure helper: deterministic branch name for the revert PR. Short and
 * predictable so two soak failures on the same merge SHA reuse the same
 * branch instead of stacking duplicates.
 */
export function revertBranchName(mergeSha: string): string {
  return `revert/${mergeSha.slice(0, 12)}`;
}

/**
 * Pure helper: PR body for the revert. Mentions the merge SHA, the failing
 * workflow names, and the original PR for traceability.
 */
export function buildRevertPrBody(meta: SoakContextMeta, failed: CiRun[]): string {
  const lines: string[] = [];
  lines.push(`Auto-revert opened by TamTam post-merge watcher.`);
  lines.push('');
  lines.push(`- Merge commit: \`${meta.mergeSha}\``);
  lines.push(`- Source PR: ${meta.prUrl}`);
  if (failed.length > 0) {
    lines.push('- Failed checks on default branch:');
    for (const f of failed) {
      const name = f.workflowName ?? 'workflow';
      const conc = (f.conclusion ?? 'unknown').toLowerCase();
      const url = f.url ? ` ${f.url}` : '';
      lines.push(`  - ${name} → ${conc}${url}`);
    }
  }
  lines.push('');
  lines.push(`Watch window: ${meta.watchMinutes} minute${meta.watchMinutes === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

interface QueryDefaultBranchCiArgs {
  projPath: string;
  repo: string;
  defaultBranch: string;
  mergeSha: string;
}

/**
 * Side-effectful: read `gh run list` for runs on the merge commit. Returns
 * an empty list when GitHub hasn't reported any yet (which the caller
 * treats as "none").
 */
export async function queryDefaultBranchCi(args: QueryDefaultBranchCiArgs): Promise<CiRun[]> {
  const r = await exec(
    'gh',
    [
      'run', 'list',
      '--repo', args.repo,
      '--branch', args.defaultBranch,
      '--commit', args.mergeSha,
      '--limit', '20',
      '--json', 'status,conclusion,url,workflowName,databaseId',
    ],
    { cwd: args.projPath, timeout: 20_000 },
  );
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p): CiRun => ({
        status: typeof p?.status === 'string' ? p.status : '',
        conclusion: typeof p?.conclusion === 'string' ? p.conclusion : null,
        url: typeof p?.url === 'string' ? p.url : undefined,
        workflowName: typeof p?.workflowName === 'string' ? p.workflowName : undefined,
        databaseId: typeof p?.databaseId === 'number' ? p.databaseId : undefined,
      }))
      .filter((r) => r.status !== '');
  } catch {
    return [];
  }
}

export interface OpenRevertPrArgs {
  projPath: string;
  repo: string;
  defaultBranch: string;
  meta: SoakContextMeta;
  failed: CiRun[];
  log: (s: string) => void;
}

export interface OpenRevertPrResult {
  ok: boolean;
  prUrl?: string;
  branch: string;
  error?: string;
}

/**
 * Open (or reuse) a revert PR for the merge SHA. Best-effort:
 *   - hard reset working tree to the default branch
 *   - create the deterministic revert branch
 *   - `git revert --no-edit <sha>`
 *   - push + `gh pr create`
 *
 * Returns `{ ok: false }` with a one-line error on any failure. The soak
 * job marks the run as failed but the merge stays on origin — operators
 * can still revert manually.
 */
export async function openRevertPr(args: OpenRevertPrArgs): Promise<OpenRevertPrResult> {
  const { projPath, repo, defaultBranch, meta, failed, log } = args;
  const branch = revertBranchName(meta.mergeSha);

  // Make sure we're on the default branch and clean before branching.
  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (statusR.stdout.trim().length > 0) {
    log(`# soak revert: working tree dirty, aborting revert PR\n`);
    return { ok: false, branch, error: 'working tree dirty before revert' };
  }
  await exec('git', ['-C', projPath, 'fetch', 'origin', defaultBranch], { timeout: 30_000 });
  const co = await exec('git', ['-C', projPath, 'checkout', defaultBranch], { timeout: 10_000 });
  if (co.exitCode !== 0) {
    log(`# soak revert: checkout ${defaultBranch} failed: ${co.stderr.trim()}\n`);
    return { ok: false, branch, error: `checkout ${defaultBranch} failed` };
  }
  await exec('git', ['-C', projPath, 'pull', '--ff-only', 'origin', defaultBranch], { timeout: 30_000 });

  // Create or reuse the revert branch off the freshly pulled default.
  const branchR = await exec('git', ['-C', projPath, 'checkout', '-B', branch], { timeout: 10_000 });
  if (branchR.exitCode !== 0) {
    log(`# soak revert: branch ${branch} failed: ${branchR.stderr.trim()}\n`);
    return { ok: false, branch, error: `branch create failed` };
  }

  const revertR = await exec(
    'git',
    ['-C', projPath, 'revert', '--no-edit', meta.mergeSha],
    { timeout: 30_000 },
  );
  if (revertR.exitCode !== 0) {
    log(`# soak revert: git revert failed: ${revertR.stderr.trim()}\n`);
    // Bail back to default so the working tree isn't left mid-revert.
    await exec('git', ['-C', projPath, 'revert', '--abort'], { timeout: 5_000 });
    await exec('git', ['-C', projPath, 'checkout', defaultBranch], { timeout: 10_000 });
    return { ok: false, branch, error: 'git revert failed' };
  }

  const pushR = await exec(
    'git',
    ['-C', projPath, 'push', '-u', 'origin', branch, '--force-with-lease'],
    { timeout: 30_000 },
  );
  if (pushR.exitCode !== 0) {
    log(`# soak revert: push ${branch} failed: ${pushR.stderr.trim()}\n`);
    return { ok: false, branch, error: 'push failed' };
  }

  const title = `revert: rollback ${meta.mergeSha.slice(0, 7)} (post-merge CI failure)`;
  const body = buildRevertPrBody(meta, failed);
  const prR = await exec(
    'gh',
    ['pr', 'create', '--repo', repo, '--base', defaultBranch, '--head', branch, '--title', title, '--body', body],
    { cwd: projPath, timeout: 30_000 },
  );
  if (prR.exitCode !== 0) {
    // If a PR for this branch already exists, surface its URL instead of failing.
    const existing = await exec(
      'gh',
      ['pr', 'view', branch, '--repo', repo, '--json', 'url', '--jq', '.url'],
      { cwd: projPath, timeout: 15_000 },
    );
    if (existing.exitCode === 0 && existing.stdout.trim().length > 0) {
      log(`# soak revert: PR already open — ${existing.stdout.trim()}\n`);
      return { ok: true, prUrl: existing.stdout.trim(), branch };
    }
    log(`# soak revert: gh pr create failed: ${prR.stderr.trim()}\n`);
    return { ok: false, branch, error: 'pr create failed' };
  }
  const prUrl = prR.stdout.trim().split(/\s+/).pop() ?? '';
  if (!prUrl) {
    log(`# soak revert: gh pr create exited 0 but returned no URL\n`);
    return { ok: false, branch, error: 'pr create returned empty url' };
  }
  return { ok: true, prUrl, branch };
}

/**
 * Best-effort: enable squash auto-merge for the just-opened revert PR.
 * Failure is logged but does not affect the soak job's exit code — the PR
 * stays open for manual review.
 */
export async function autoMergeRevertPr(
  projPath: string,
  repo: string,
  prUrl: string,
  log: (s: string) => void,
): Promise<void> {
  const r = await exec(
    'gh',
    ['pr', 'merge', prUrl, '--repo', repo, '--squash', '--auto', '--delete-branch'],
    { cwd: projPath, timeout: 30_000 },
  );
  if (r.stdout) log(r.stdout);
  if (r.stderr) log(r.stderr);
  if (r.exitCode !== 0) log(`# soak: auto-merge of revert PR failed (left open for manual review)\n`);
}

/**
 * Notify the operator of the revert. Best-effort: `notify` already swallows
 * webhook errors and never throws.
 */
export async function notifyPostMergeRevert(args: {
  jobId: string;
  projectName: string;
  meta: SoakContextMeta;
  failed: CiRun[];
  revertPrUrl: string | null;
  reason: string;
}): Promise<void> {
  try {
    const { notify } = await import('@/lib/shared/notifications');
    const summary = args.failed
      .slice(0, 3)
      .map((f) => f.workflowName ?? 'workflow')
      .join(', ');
    await notify({
      event: 'post_merge_revert',
      project: args.projectName,
      job_id: args.jobId,
      status: 'failed',
      message: `Default-branch CI failed on ${args.meta.mergeSha.slice(0, 7)} (${summary || 'no workflow name'})`,
      log_url: args.revertPrUrl ?? args.meta.prUrl,
      reason: args.reason,
      timestamp: Date.now(),
      throttleKeySuffix: args.meta.mergeSha,
    });
  } catch (err) {
    console.error('[soak] notifyPostMergeRevert failed:', err);
  }
}

export interface LaunchSoakArgs {
  projectName: string;
  meta: SoakContextMeta;
}

export interface LaunchSoakResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

/**
 * Stand up a soak job row, write the initial log header, and persist the
 * watcher's context on `contextMeta`. The phase workflow calls this and
 * then drives the polling loop in its own `'use step'` bodies.
 */
export function launchSoak(args: LaunchSoakArgs): LaunchSoakResult {
  const projPath = resolveProjectPath(args.projectName);
  if (!projPath) return { ok: false, error: 'project not found' };

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const meta = JSON.stringify(args.meta);
  const job = createJob(args.projectName, 'soak', 0, '', undefined, meta);
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  try {
    appendRedactedFileSync(
      logPath,
      `# soak start — ${new Date().toISOString()}\n# watching ${args.meta.defaultBranch} CI on ${args.meta.mergeSha} for ${args.meta.watchMinutes} min\n`,
    );
  } catch { /* log-write failures are non-fatal */ }

  return { ok: true, jobId: job.id };
}

/** Append a log line for the soak job, swallowing log-write failures. */
export function appendSoakLog(jobId: string, line: string): void {
  const job = getJob(jobId);
  if (!job?.logPath) return;
  try { appendRedactedFileSync(job.logPath, line); } catch {}
}

/** Finalize a soak job row with an exit code. */
export async function finalizeSoakJob(jobId: string, exitCode: number): Promise<JobData | null> {
  const job = getJob(jobId);
  if (!job) return null;
  await markDone(job, exitCode);
  return job;
}

/**
 * Flip `projects.paused = true` so admission gates (`isProjectPaused()`) stop
 * accepting new agent runs or releases on this project until a human resumes
 * it from Settings.
 *
 * Mirrors the side effects of the PATCH /api/projects/by-project/<name> route
 * without crossing the HTTP boundary — usable from inside workflow steps.
 *
 * Returns true on success, false on any failure (already logged).
 */
export async function pauseProjectForSoakFailure(projectName: string): Promise<boolean> {
  const [
    { db },
    schema,
    { eq },
    { clearProjectDataCache },
    { refreshProjectsCacheSync },
  ] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
    import('@/lib/shared/project-data'),
    import('@/lib/shared/enabled-projects'),
  ]);
  try {
    await db.update(schema.projects)
      .set({ paused: true })
      .where(eq(schema.projects.name, projectName));
    // Record WHY so the inbox surfaces a resumable `project_paused` HITL — a
    // silent pause is a bug (operator rule).
    const { setPauseReason } = await import('@/lib/pipeline/pause-project');
    await setPauseReason(projectName, 'Post-merge soak failed — CI went red on the default branch after merge. Investigate the regression, then resume.');
    clearProjectDataCache();
    await refreshProjectsCacheSync();
    return true;
  } catch (err) {
    console.error(`[soak] pauseProjectForSoakFailure(${projectName}) failed:`, err);
    return false;
  }
}
