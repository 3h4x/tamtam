import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { db, schema } from './db';
import { getJobStatus } from './pm2-jobs';
import { markReviewed } from './git-utils';
import { parseStreamLines } from './claude-stream-parser';
import { costUsd } from './usage-pricing';

export interface JobData {
  id: string;
  project: string;
  kind: string;
  prompt: string | null;
  pid: number;
  logPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  seen: boolean;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreateTokens?: number | null;
  sessionId?: string | null;
  contextMeta?: string | null;
  userPrompt?: string | null;
  parentJobId?: string | null;
  ghIssueNumber?: number | null;
  ghIssueRepo?: string | null;
  ghIssueTitle?: string | null;
  logPruned?: boolean | null;
  costUsd?: number | null;
  model?: string | null;
}

const jobsCache = new Map<string, JobData>();
let loaded = false;

function loadFromDb(): void {
  if (loaded) return;
  try {
    const rows = db.select().from(schema.jobs).all();
    for (const row of rows) {
      jobsCache.set(row.id, {
        id: row.id,
        project: row.project,
        kind: row.kind,
        prompt: row.prompt ?? null,
        pid: row.pid,
        logPath: row.logPath,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? null,
        exitCode: row.exitCode ?? null,
        seen: row.seen ?? false,
        durationMs: row.durationMs ?? null,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        cacheReadTokens: row.cacheReadTokens ?? null,
        cacheCreateTokens: row.cacheCreateTokens ?? null,
        sessionId: row.sessionId ?? null,
        contextMeta: row.contextMeta ?? null,
        userPrompt: row.userPrompt ?? null,
        parentJobId: row.parentJobId ?? null,
        ghIssueNumber: row.ghIssueNumber ?? null,
        ghIssueRepo: row.ghIssueRepo ?? null,
        ghIssueTitle: row.ghIssueTitle ?? null,
        logPruned: row.logPruned ?? false,
        costUsd: row.costUsd ?? null,
        model: row.model ?? null,
      });
    }
    loaded = true;
  } catch (e) {
    console.error('Failed to load jobs from DB:', e);
  }
}

function saveToDb(job: JobData): void {
  try {
    db.insert(schema.jobs)
      .values({
        id: job.id,
        project: job.project,
        kind: job.kind,
        prompt: job.prompt,
        pid: job.pid,
        logPath: job.logPath,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        seen: job.seen,
        durationMs: job.durationMs,
        inputTokens: job.inputTokens,
        outputTokens: job.outputTokens,
        cacheReadTokens: job.cacheReadTokens,
        cacheCreateTokens: job.cacheCreateTokens,
        sessionId: job.sessionId,
        contextMeta: job.contextMeta,
        userPrompt: job.userPrompt,
        ghIssueNumber: job.ghIssueNumber ?? null,
        ghIssueRepo: job.ghIssueRepo ?? null,
        ghIssueTitle: job.ghIssueTitle ?? null,
        logPruned: job.logPruned ?? false,
        costUsd: job.costUsd ?? null,
        model: job.model ?? null,
      })
      .onConflictDoUpdate({
        target: schema.jobs.id,
        set: {
          pid: job.pid,
          logPath: job.logPath,
          finishedAt: job.finishedAt,
          exitCode: job.exitCode,
          seen: job.seen,
          durationMs: job.durationMs,
          inputTokens: job.inputTokens,
          outputTokens: job.outputTokens,
          cacheReadTokens: job.cacheReadTokens,
          cacheCreateTokens: job.cacheCreateTokens,
          sessionId: job.sessionId,
          contextMeta: job.contextMeta,
          userPrompt: job.userPrompt,
          logPruned: job.logPruned ?? false,
          costUsd: job.costUsd ?? null,
          model: job.model ?? null,
        },
      })
      .run();
  } catch (e) {
    console.error(`Failed to save job ${job.id}:`, e);
  }
}

export async function markDone(job: JobData, exitCode: number): Promise<void> {
  // Idempotent: if already finalized, don't double-fire hooks or rewrite DB.
  if (job.finishedAt !== null) {
    await reconcileStaleRelease(job);
    return;
  }
  // Also check the DB — two concurrent probes can each hold a fresh JobData
  // instance (fetched via separate listJobs() calls), both see finishedAt ===
  // null, and both run the completion hook, producing double "release
  // finished" markers, double fix chains, and orphaned child jobs. Consult
  // the DB so the first writer wins. better-sqlite3 is synchronous so this
  // check-then-write is atomic w.r.t. the JS event loop; no await means no
  // other markDone can interleave here.
  const dbRow = db.select({ finishedAt: schema.jobs.finishedAt })
    .from(schema.jobs).where(eq(schema.jobs.id, job.id)).get();
  if (dbRow?.finishedAt != null) {
    job.finishedAt = dbRow.finishedAt; // keep in-memory object in sync
    // A concurrent markDone (e.g. another probe) finalized this job first.
    // Its completion hook may have crashed before finalizing the release
    // meta-job, leaving the pipeline UI stuck on "running". Reconcile here.
    await reconcileStaleRelease(job);
    return;
  }
  job.finishedAt = Date.now() / 1000;
  job.exitCode = exitCode;
  // Extract result metadata (tokens, duration, session) from log.
  // NOTE: we skip this for `release` meta-jobs. Their log is an aggregate of
  // child logs, so parseStreamLines would find the *child's* session_id and
  // falsely assign it to the release — later the UI would treat release +
  // review as the same session, merge them, and shrink the release's
  // apparent window (hiding commit/push from release grouping).
  const shouldExtractMetadata = job.kind !== 'release';
  const rawLog = shouldExtractMetadata ? readLog(job, 50_000) : '';
  const events = shouldExtractMetadata ? parseStreamLines(rawLog) : [];
  const doneEvent = events.find(e => e.type === 'done');
  if (doneEvent && doneEvent.type === 'done') {
    job.durationMs = doneEvent.result.duration;
    job.inputTokens = doneEvent.result.inputTokens;
    job.outputTokens = doneEvent.result.outputTokens;
    job.cacheReadTokens = doneEvent.result.cacheReadTokens;
    job.cacheCreateTokens = doneEvent.result.cacheCreateTokens;
    job.sessionId = doneEvent.result.sessionId;
    job.model = doneEvent.result.model ?? null;
    job.costUsd = costUsd({
      inputTokens: job.inputTokens,
      outputTokens: job.outputTokens,
      cacheReadTokens: job.cacheReadTokens,
      cacheCreateTokens: job.cacheCreateTokens,
    });
    // Claude completed successfully — override pm2's exit code. Claude CLI
    // frequently hangs for a few seconds after flushing its final result
    // event (flushing stdio, tearing down child processes) and gets killed
    // by pm2's hard-timeout or our SIGKILL fallback, which makes pm2 report
    // exit -1 / 137. If the stream-json result line says is_error=false,
    // the logical outcome was a clean finish — trust that over pm2's code.
    const isClaudeKind = (
      job.kind === 'run' ||
      job.kind === 'review' ||
      job.kind === 'fix' ||
      job.kind === 'fix-ci' ||
      job.kind === 'fix-push' ||
      job.kind.startsWith('agent:')
    );
    if (isClaudeKind && !doneEvent.result.error && exitCode !== 0) {
      console.log(`[job ${job.id}] claude result present (is_error=false) but pm2 reported exit ${exitCode}; overriding to 0`);
      job.exitCode = 0;
    }
    // Opposite direction: claude emitted a result with is_error=true (e.g. 404
    // on an unavailable model). probeJobStatus calls markDone(job, 0) for any
    // terminal result line, and pm2's exit_code may also be 0 if the wrapper
    // swallowed it — but the logical outcome was a failure, so reflect that.
    if (isClaudeKind && doneEvent.result.error && job.exitCode === 0) {
      console.log(`[job ${job.id}] claude result present (is_error=true) but exit code is 0; overriding to 1`);
      job.exitCode = 1;
    }
  }
  saveToDb(job);
  try {
    db.delete(schema.ghIssuesCache).where(eq(schema.ghIssuesCache.project, job.project)).run();
  } catch {}
  await runCompletionHooks(job);
  // Clean up PM2 process now that it's saved to DB
  try {
    const { deleteJob } = await import('./pm2-jobs');
    await deleteJob(job.id);
  } catch {}
  // Fallback: explicitly SIGKILL the bash wrapper and any children in case
  // Claude CLI hung and escaped pm2's tree-kill.
  if (job.pid > 0) {
    try {
      const { exec } = await import('./shell');
      const { stdout } = await exec('pgrep', ['-P', String(job.pid)], { timeout: 2000 });
      const children = stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
      const pids = [job.pid, ...children];
      const alive: number[] = [];
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
          alive.push(pid);
        } catch {}
      }
      if (alive.length > 0) {
        console.log(`[job ${job.id}] force-killed hung process(es) after completion: ${alive.join(', ')}`);
      }
    } catch {}
  }
}

async function getProjectPipelineConfig(projectName: string): Promise<{ autoCommitEnabled: boolean; autoPushEnabled: boolean; releaseAfterRun: boolean; autoPrMergeEnabled: boolean; prWorkflowEnabled: boolean }> {
  try {
    const { getProjectTestConfig } = await import('./scheduling');
    const cfg = getProjectTestConfig(projectName);
    return {
      autoCommitEnabled: !!cfg?.autoCommitEnabled,
      autoPushEnabled: !!cfg?.autoPushEnabled,
      releaseAfterRun: !!cfg?.releaseAfterRun,
      autoPrMergeEnabled: !!cfg?.autoPrMergeEnabled,
      prWorkflowEnabled: !!cfg?.prWorkflowEnabled,
    };
  } catch {
    return { autoCommitEnabled: false, autoPushEnabled: false, releaseAfterRun: false, autoPrMergeEnabled: false, prWorkflowEnabled: false };
  }
}

// Cap runaway review→fix→review loops when auto-push is on. Override via
// TAMTAM_MAX_FIX_ITERATIONS / TAMTAM_FIX_WINDOW_SECONDS for debugging or tuning
// per-environment without a code change.
const MAX_FIX_ITERATIONS = parseInt(process.env.TAMTAM_MAX_FIX_ITERATIONS ?? '', 10) || 3;
const FIX_WINDOW_SECONDS = parseInt(process.env.TAMTAM_FIX_WINDOW_SECONDS ?? '', 10) || 30 * 60;
// fix-ci retries — live-read from settings so the user can tune this in the UI
// without restarting the server. Only crash-fast failures are retried so real
// errors still surface.
async function getFixCiRetryConfig(): Promise<{ maxRetries: number; windowSeconds: number; fastCrashMs: number }> {
  try {
    const { getSettings } = await import('./config');
    const s = getSettings();
    return {
      maxRetries: s.fix_ci_max_retries,
      windowSeconds: s.fix_ci_retry_window_seconds,
      fastCrashMs: s.fix_ci_fast_crash_ms,
    };
  } catch {
    return { maxRetries: 2, windowSeconds: 120, fastCrashMs: 5000 };
  }
}

function recentFixCiCount(projectName: string, windowSeconds: number): number {
  const cutoff = Date.now() / 1000 - windowSeconds;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-ci' && j.startedAt >= cutoff
  ).length;
}

// Cap auto-fix-push retries so a stubbornly-broken lint rule can't spin
// Claude in a loop. Same 30min window as review-fix for consistency.
const MAX_FIX_PUSH_ATTEMPTS = 2;

function recentFixPushCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix-push' && j.startedAt >= cutoff
  ).length;
}

function recentFixCount(projectName: string): number {
  const cutoff = Date.now() / 1000 - FIX_WINDOW_SECONDS;
  return listJobs().filter(
    (j) => j.project === projectName && j.kind === 'fix' && j.startedAt >= cutoff
  ).length;
}

// Find the most recent in-flight release job for this project — the single
// terminal the user watches during a release. Each pipeline step appends
// its section to this job's log.
function findActiveReleaseJob(projectName: string): JobData | null {
  const candidates = listJobs()
    .filter(j => j.project === projectName && j.kind === 'release' && j.finishedAt === null)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return candidates[0] ?? null;
}

function appendToReleaseLog(release: JobData, kind: string, job: JobData, extra?: string): void {
  if (!release.logPath) return;
  try {
    const header = `\n\n=== ${kind} (${job.id}) — started ${new Date((job.startedAt || 0) * 1000).toISOString()} — exit ${job.exitCode ?? '?'} ===\n`;
    let body = '';
    if (job.logPath && existsSync(job.logPath)) {
      try { body = readFileSync(job.logPath, 'utf-8'); } catch {}
    }
    appendFileSync(release.logPath, header + body + (extra ? `\n${extra}\n` : ''));
  } catch {}
}

// Safety net: if the given job is a pipeline step, make sure the active
// release for its project eventually gets finalized. The normal path is
// via runCompletionHooks, but races (concurrent probes, a throw mid-hook)
// can leave the release stranded with all its children already done. This
// runs cheaply on every markDone call and only acts when the release has
// no running children and its most recent child finished long enough ago
// that we're confident nothing else is about to chain.
const PIPELINE_STEP_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod']);
const RELEASE_RECONCILE_GRACE_MS = 5_000;

// A child is part of a release's chain only if it starts shortly after the
// release (or shortly after the previous step finished). Beyond this gap we
// assume an unrelated pipeline job crept in while the release was stuck and
// should NOT be counted in the finalized exit code.
const PIPELINE_CHAIN_GAP_SEC = 60;

async function reconcileStaleRelease(job: JobData): Promise<void> {
  if (!PIPELINE_STEP_KINDS.has(job.kind)) return;
  const release = findActiveReleaseJob(job.project);
  if (!release) return;
  const now = Date.now() / 1000;
  const releaseStart = release.startedAt || 0;
  // Candidate children: pipeline-step jobs for this project that started at
  // or after the release. Sorted by startedAt so we can walk the chain.
  const candidates = listJobs()
    .filter((j) => j.project === release.project
      && PIPELINE_STEP_KINDS.has(j.kind)
      && (j.startedAt || 0) >= releaseStart - 1)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  // Walk the chain: accept the first child if it started within the chain
  // gap of the release start, then each subsequent child if it started within
  // the gap of the previous child's finish. Break once the chain breaks —
  // later jobs are unrelated activity.
  const chain: JobData[] = [];
  let edge = releaseStart;
  for (const c of candidates) {
    if ((c.startedAt || 0) - edge > PIPELINE_CHAIN_GAP_SEC) break;
    chain.push(c);
    // If a child is still running, defer: the chain is active.
    if (c.finishedAt === null) return;
    edge = c.finishedAt || edge;
  }
  if (chain.length === 0) return;
  if ((now - edge) * 1000 < RELEASE_RECONCILE_GRACE_MS) return;
  const worstExit = chain.reduce(
    (acc, c) => (c.exitCode != null && c.exitCode !== 0 ? 1 : acc),
    0,
  );
  try {
    await finalizeReleaseJob(release, worstExit);
    console.log(`[release] reconciled stale release ${release.id} (${job.project}) — ${chain.length} chained step${chain.length === 1 ? '' : 's'}, exit ${worstExit}`);
  } catch (e) {
    console.log(`[release] reconciler failed for ${release.id}:`, e);
  }
}

async function finalizeReleaseJob(release: JobData, exitCode: number): Promise<void> {
  if (release.finishedAt !== null) return;
  try {
    if (release.logPath) {
      appendFileSync(release.logPath, `\n# release finished — exit ${exitCode} — ${new Date().toISOString()}\n`);
    }
  } catch {}
  await markDone(release, exitCode);
  // Release the pipeline lock
  try {
    const { releaseLock } = await import('./pipeline-lock');
    releaseLock(release.project, release.id);
  } catch {}
}

async function runCompletionHooks(job: JobData): Promise<void> {
  // Stream per-step output into the active release meta-log so the user can
  // watch the whole pipeline in one terminal.
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod'].includes(job.kind)) {
    const release = findActiveReleaseJob(job.project);
    if (release) appendToReleaseLog(release, job.kind, job);
  }

  // Tracks whether this hook kicked off a downstream step. If not, the
  // release meta-job is at a natural endpoint and should be finalized so the
  // UI doesn't render it as "live" forever.
  let chainedNext = false;
  let notificationEvent: import('./notifications').NotificationEvent | null = null;

  if (job.kind === 'review') {
    if (job.exitCode === 0) {
      try {
        const { resolveProjectPath } = await import('./project-data');
        const projPath = resolveProjectPath(job.project);
        if (projPath) await markReviewed(job.project, projPath);
      } catch {}
    }
    // Release pipeline: review LGTM → push; NEEDS ATTENTION/DO NOT SHIP → fix
    try {
      const inRelease = !!findActiveReleaseJob(job.project);
      const pipelineCfg = await getProjectPipelineConfig(job.project);
      if (job.exitCode === 0 && (inRelease || pipelineCfg.autoPushEnabled || pipelineCfg.autoCommitEnabled)) {
        // Treat a missing verdict as NEEDS ATTENTION rather than silently
        // finalizing as success. Models sometimes narrate a problem and
        // propose a fix without emitting the formal "Verdict: X" line —
        // shipping in that case is dangerous. The fix loop is idempotent
        // (Claude will re-review and emit LGTM if nothing's broken).
        const rawVerdict = getVerdict(job);
        const verdict = rawVerdict ?? 'NEEDS ATTENTION';
        if (!rawVerdict) {
          console.log(`[release] review ${job.id} emitted no verdict — defaulting to NEEDS ATTENTION`);
        }
        if (verdict === 'LGTM') {
          // DoD verification only makes sense in PR Workflow mode AND when we
          // have a linked GitHub issue. On a direct-branch release (no PR, no
          // issue) there are no acceptance-criteria checkboxes to tick, so
          // running mark-dod just burns Claude calls and risks stalling the
          // release on an inline claude-cli invocation.
          //
          // When PR Workflow + auto_pr_merge + issue are all set, defer DoD
          // to launchPrWait (post-merge) so verification reflects the merged
          // state. Otherwise (PR Workflow + issue but no auto-merge) run it
          // now so the review can tick boxes before manual merge.
          const hasIssueContext = listJobs().some(
            j => j.project === job.project && j.kind === 'run' && j.ghIssueNumber != null,
          );
          const prWorkflow = !!pipelineCfg.prWorkflowEnabled;
          const shouldRunDod = prWorkflow && hasIssueContext;
          const shouldDeferDod = shouldRunDod && pipelineCfg.autoPrMergeEnabled;
          if (shouldRunDod && !shouldDeferDod) {
            try {
              const { startMarkDod } = await import('./start-mark-dod');
              const md = await startMarkDod(job.project);
              if (md.ok) {
                console.log(`[release] DoD verification for #${md.issueNumber}: ${md.verified}/${md.total} verified${md.changed ? ' (issue updated)' : ''}`);
              }
            } catch (e) {
              console.log(`[release] mark-dod error for ${job.project}:`, e);
            }
          } else if (shouldDeferDod) {
            console.log(`[release] deferring mark-dod to post-merge for ${job.project} (auto_pr_merge_enabled)`);
          } else {
            console.log(`[release] skipping mark-dod for ${job.project} (pr_workflow_enabled=${prWorkflow}, hasIssueContext=${hasIssueContext})`);
          }
          const { startProjectCommit } = await import('./start-commit');
          const r = await startProjectCommit(job.project);
          if (!r.ok) {
            console.log(`[release] commit failed for ${job.project}: ${r.detail}`);
          } else {
            console.log(`[release] review LGTM → committed ${job.project} (${r.commitSha || 'no-op'})`);
          }
          // startProjectCommit creates a 'commit' job that will itself chain to push
          // (or finalize the release) via its own completion hook.
          chainedNext = true;
        } else if (verdict === 'NEEDS ATTENTION' || verdict === 'DO NOT SHIP') {
          if (verdict === 'DO NOT SHIP') {
            notificationEvent = 'review_do_not_ship';
          }
          const count = recentFixCount(job.project);
          if (count < MAX_FIX_ITERATIONS) {
            const { startFixFromJob } = await import('./start-fix');
            const r = await startFixFromJob(job.id);
            if (r.ok) {
              console.log(`[release] review ${verdict} → started fix ${r.jobId} (iter ${count + 1})`);
              chainedNext = true;
            } else {
              console.log(`[release] skipped fix for ${job.project}: ${r.detail}`);
            }
          } else {
            console.log(`[release] fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
            notificationEvent = 'fix_loop_exhausted';
          }
        }
        // With the default-to-NEEDS-ATTENTION above, verdict is always one of
        // LGTM / NEEDS ATTENTION / DO NOT SHIP here. No null fallthrough.
      }
    } catch (e) {
      console.log(`[release] review hook error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'fix' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      if (!!findActiveReleaseJob(job.project) || autoPushEnabled || autoCommitEnabled) {
        const { startProjectReview } = await import('./start-review');
        const r = await startProjectReview(job.project);
        if (r.ok) {
          console.log(`[fix→review] auto-started review ${r.jobId} for ${job.project}`);
          chainedNext = true;
        } else {
          console.log(`[fix→review] skipped auto-review for ${job.project}: ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[fix→review] error starting auto-review for ${job.project}:`, e);
    }
  }

  if (job.kind === 'commit' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled) {
        const { startProjectPush } = await import('./start-push');
        const r = await startProjectPush(job.project);
        if (r.ok) {
          chainedNext = true;
          console.log(`[commit→push] pushed ${job.project} (${r.commitSha || 'no-op'})`);
        } else {
          console.log(`[commit→push] push failed for ${job.project}: ${r.detail}`);
        }
      } else if (autoCommitEnabled && !autoPushEnabled) {
        // commit-only mode: commit is done, no push needed — finalize here
        console.log(`[commit] commit-only mode — not chaining to push for ${job.project}`);
      }
    } catch (e) {
      console.log(`[commit→push] error for ${job.project}:`, e);
    }
  }

  if (job.kind === 'test' && job.exitCode === 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const { resolveProjectPath } = await import('./project-data');
        const { exec } = await import('./shell');
        const projPath = resolveProjectPath(job.project);
        const changesR = projPath
          ? await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 })
          : null;
        const hasUncommittedChanges = changesR?.exitCode === 0 && changesR.stdout.trim().length > 0;

        if (hasUncommittedChanges) {
          // Review disabled → skip straight to commit (agent prompt covers review).
          const { getProjectTestConfig } = await import('./scheduling');
          const reviewDisabled = !!getProjectTestConfig(job.project)?.reviewDisabled;
          if (reviewDisabled) {
            const { startProjectCommit } = await import('./start-commit');
            const r = await startProjectCommit(job.project);
            if (r.ok) {
              console.log(`[release] tests passed + review disabled → commit for ${job.project}`);
              chainedNext = true;
            } else {
              console.log(`[release] test→commit skipped for ${job.project}: ${r.detail}`);
            }
          } else {
            const { startProjectReview } = await import('./start-review');
            const r = await startProjectReview(job.project);
            if (r.ok) {
              console.log(`[release] tests passed → started review ${r.jobId} for ${job.project}`);
              chainedNext = true;
            } else {
              console.log(`[release] test→review skipped for ${job.project}: ${r.detail}`);
            }
          }
        } else {
          // Tests passed and nothing to commit — push existing commits directly.
          const { startProjectPush } = await import('./start-push');
          const r = await startProjectPush(job.project);
          if (r.ok) {
            console.log(`[release] tests passed (no changes) → push ${job.project}`);
            chainedNext = true;
          } else {
            console.log(`[release] test→push skipped for ${job.project}: ${r.detail}`);
          }
        }
      }
    } catch (e) {
      console.log(`[release] test hook error for ${job.project}:`, e);
    }
  }

  // Test failed: kick off a fix job using the test log. The fix→review hook
  // will then chain to review → commit → push. Bounded by the same fix cap
  // as review→fix so a persistently-broken test can't spin Claude forever.
  if (job.kind === 'test' && job.exitCode !== null && job.exitCode !== 0) {
    try {
      const { autoCommitEnabled, autoPushEnabled } = await getProjectPipelineConfig(job.project);
      const inRelease = !!findActiveReleaseJob(job.project);
      if (inRelease || autoPushEnabled || autoCommitEnabled) {
        const count = recentFixCount(job.project);
        if (count < MAX_FIX_ITERATIONS) {
          const { startFixFromJob } = await import('./start-fix');
          const r = await startFixFromJob(job.id);
          if (r.ok) {
            console.log(`[release] test failed → started fix ${r.jobId} (iter ${count + 1})`);
            chainedNext = true;
          } else {
            console.log(`[release] test→fix skipped for ${job.project}: ${r.detail}`);
          }
        } else {
          console.log(`[release] test→fix cap reached for ${job.project} (${count}/${MAX_FIX_ITERATIONS}) — stopping`);
          notificationEvent = 'fix_loop_exhausted';
        }
      }
    } catch (e) {
      console.log(`[release] test-fail hook error for ${job.project}:`, e);
    }
  }

  // Auto-merge: when a push succeeds with a PR and auto_pr_merge_enabled is on,
  // launch a pr-wait job that polls checks and merges once they pass.
  if (job.kind === 'push' && job.exitCode === 0) {
    try {
      const { autoPrMergeEnabled, prWorkflowEnabled } = await getProjectPipelineConfig(job.project);
      if (autoPrMergeEnabled && job.contextMeta) {
        const meta = JSON.parse(job.contextMeta) as { prUrl?: string; prNumber?: number; prRepo?: string };
        if (meta.prUrl && meta.prNumber && meta.prRepo) {
          const { launchPrWait } = await import('./start-pr-wait');
          const r = launchPrWait(job.project, meta.prNumber, meta.prRepo, meta.prUrl);
          if ('jobId' in r) {
            console.log(`[push→pr-wait] started pr-wait ${r.jobId} for PR #${meta.prNumber}`);
            chainedNext = true;
          } else {
            console.log(`[push→pr-wait] failed to start pr-wait: ${r.error}`);
          }
        }
      } else if (prWorkflowEnabled && !autoPrMergeEnabled && job.contextMeta) {
        // PR Workflow without auto-merge: run DoD against the PR body now that
        // the PR exists. The auto-merge path defers this to post-merge in launchPrWait.
        const meta = JSON.parse(job.contextMeta) as { prNumber?: number };
        if (meta.prNumber) {
          try {
            const { startMarkDod } = await import('./start-mark-dod');
            const md = await startMarkDod(job.project);
            if (md.ok) {
              console.log(`[push→dod] PR #${meta.prNumber} DoD: ${md.verified}/${md.total} verified${md.changed ? ' (PR updated)' : ''}`);
            }
          } catch (e) {
            console.log(`[push→dod] mark-dod error for ${job.project}:`, e);
          }
        }
      }
    } catch (e) {
      console.log(`[push→pr-wait] error for ${job.project}:`, e);
    }
  }

  // Auto-fix-push: when a push fails because of a pre-commit / pre-push hook
  // (husky/eslint/lint-staged), spawn a Claude fix job targeting the exact
  // hook error and re-trigger the push once it finishes. Bounded by
  // MAX_FIX_PUSH_ATTEMPTS per window to prevent infinite loops on a
  // fundamentally-broken lint rule.
  if (job.kind === 'push' && job.exitCode !== 0) {
    try {
      const rawLog = readLog(job, 100_000);
      const { isHookRejection, startFixPush } = await import('./start-fix-push');
      if (isHookRejection(rawLog)) {
        const attempts = recentFixPushCount(job.project);
        if (attempts < MAX_FIX_PUSH_ATTEMPTS) {
          const r = await startFixPush(job.project, rawLog);
          if (r.ok) {
            console.log(`[push] hook rejection → auto-fix-push ${r.jobId} (attempt ${attempts + 1}/${MAX_FIX_PUSH_ATTEMPTS})`);
            chainedNext = true;
          } else {
            console.log(`[push] hook rejection — could not start fix-push: ${r.detail}`);
          }
        } else {
          console.log(`[push] hook rejection — fix-push cap reached (${attempts}/${MAX_FIX_PUSH_ATTEMPTS}) — surfacing error`);
        }
      }
    } catch (e) {
      console.log(`[push] fix-push hook error for ${job.project}:`, e);
    }
  }

  // Chain fix-push → commit → push when Claude finishes fixing.
  if (job.kind === 'fix-push' && job.exitCode === 0) {
    try {
      const { startProjectCommit } = await import('./start-commit');
      const r = await startProjectCommit(job.project);
      if (r.ok) {
        console.log(`[fix-push→commit] committed ${job.project} (${r.commitSha || 'no-op'})`);
        chainedNext = true;
      } else {
        console.log(`[fix-push→commit] commit still failing for ${job.project}: ${r.detail}`);
        chainedNext = true; // Still mark as chained — commit job will finalize
      }
    } catch (e) {
      console.log(`[fix-push→commit] retry error for ${job.project}:`, e);
    }
  }

  // If this is a pipeline step and we didn't chain to another step, the
  // release job reached a natural endpoint — finalize it. Exit code mirrors
  // this step's outcome.
  //
  // `mark-dod` is explicitly excluded: it is a best-effort side-step invoked
  // synchronously by the review hook. Treating it as an endpoint here
  // finalizes the release BEFORE the review hook gets to call
  // `startProjectCommit`, so commit/push never fire. Mark-dod's outcome is
  // purely advisory (issue checkbox updates); the release continues via its
  // invoker regardless of mark-dod's exit code.
  if (['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait'].includes(job.kind) && !chainedNext) {
    const release = findActiveReleaseJob(job.project);
    if (release) {
      const exitCode = (job.exitCode === 0) ? 0 : 1;
      // Emit release success/fail notification before finalizing
      if (!notificationEvent) {
        notificationEvent = exitCode === 0 ? 'release_success' : 'release_fail';
      }
      await finalizeReleaseJob(release, exitCode);
    } else {
      // No active release job — still need to release the lock if this was a standalone pipeline job
      try {
        const { releaseLock } = await import('./pipeline-lock');
        releaseLock(job.project, job.id);
      } catch {}
    }
  }

  // Send notification if an event was triggered
  if (notificationEvent) {
    try {
      const { notify } = await import('./notifications');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      const verdict = job.kind === 'review' ? getVerdict(job) : null;
      await notify({
        event: notificationEvent,
        project: job.project,
        job_id: job.id,
        status: job.exitCode === 0 ? 'success' : 'failed',
        verdict: verdict ?? undefined,
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send notification for ${notificationEvent}:`, e);
    }
  }

  // fix-ci auto-retry: if the job crashed fast (pm2/claude boot failure) and
  // we haven't exhausted retries, kick off another attempt so the user sees
  // a spinner instead of a red exit -1.
  if (job.kind === 'fix-ci' && job.exitCode !== null && job.exitCode !== 0) {
    const { maxRetries, windowSeconds, fastCrashMs } = await getFixCiRetryConfig();
    if (maxRetries <= 0) return; // retries disabled via settings
    const durationMs = (job.finishedAt ?? 0) * 1000 - (job.startedAt ?? 0) * 1000;
    const crashedFast = durationMs > 0 && durationMs < fastCrashMs;
    const attempts = recentFixCiCount(job.project, windowSeconds);
    if (crashedFast && attempts <= maxRetries) {
      console.log(`[fix-ci] retry ${attempts}/${maxRetries} for ${job.project} — previous crashed in ${durationMs}ms`);
      const delayMs = Math.min(500 * attempts, 3000);
      setTimeout(() => {
        retryFixCi(job.project).catch((e) => {
          console.log(`[fix-ci] retry error for ${job.project}:`, e);
        });
      }, delayMs);
    } else if (attempts > maxRetries) {
      console.log(`[fix-ci] retry cap reached for ${job.project} (${attempts}/${maxRetries}) — giving up`);
    }
  }

  // Agent run failures: notify on agent run failures
  if (job.kind.startsWith('agent:') && job.exitCode !== 0) {
    try {
      const { notify } = await import('./notifications');
      const agentName = job.kind.replace('agent:', '');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      await notify({
        event: 'agent_run_fail',
        project: job.project,
        agent: agentName,
        job_id: job.id,
        status: 'failed',
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send agent_run_fail notification:`, e);
    }
  }

  // Release-after-run: when a terminal/agent run finishes successfully, auto-trigger the release pipeline.
  if ((job.kind === 'run' || job.kind.startsWith('agent:')) && job.exitCode === 0) {
    try {
      const { releaseAfterRun } = await getProjectPipelineConfig(job.project);
      if (releaseAfterRun) {
        const { startRelease } = await import('./start-release');
        const r = await startRelease(job.project);
        if (r.ok) {
          console.log(`[release-after-run] triggered release ${r.jobId} for ${job.project} after run ${job.id}`);
        } else {
          console.log(`[release-after-run] skipped for ${job.project}: ${r.detail}`);
        }
      }
    } catch (e) {
      console.log(`[release-after-run] error for ${job.project}:`, e);
    }
  }

  // Log retention: prune old log files for this project now that a new run completed.
  try {
    const { pruneProjectLogs } = await import('./retention');
    pruneProjectLogs(job.project);
  } catch (e) {
    console.error(`[retention] pruneProjectLogs failed for ${job.project}:`, e);
  }
}

async function retryFixCi(projectName: string): Promise<void> {
  // Re-invoke the fix-ci API route's logic by calling it HTTP-less. We post
  // to the same endpoint so it stays the single source of truth for the
  // "start a fix-ci" flow (prompt construction, log path, permission mode).
  const port = parseInt(process.env.PORT ?? '', 10) || 1337;
  try {
    await fetch(`http://127.0.0.1:${port}/api/projects/by-project/${encodeURIComponent(projectName)}/fix-ci`, {
      method: 'POST',
    });
  } catch (e) {
    console.log(`[fix-ci] retry fetch failed for ${projectName}:`, e);
  }
}

export function readLog(job: JobData, tailBytes = 100_000): string {
  if (!job.logPath || !existsSync(job.logPath)) return '';
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    if (content.length > tailBytes) {
      const tail = content.slice(-tailBytes);
      const newlineIdx = tail.indexOf('\n');
      return newlineIdx >= 0 ? tail.slice(newlineIdx + 1) : tail;
    }
    return content;
  } catch {
    return '';
  }
}

export function readParsedLog(job: JobData, tailBytes = 100_000): string {
  const rawLog = readLog(job, tailBytes);
  if (!rawLog) return '';

  // Try to parse as stream events and extract text
  const events = parseStreamLines(rawLog);
  const textParts: string[] = [];

  for (const event of events) {
    if (event.type === 'text') {
      textParts.push(event.text);
    } else if (event.type === 'tool_use') {
      textParts.push(`\n\n> Tool: ${event.name}\n`);
    } else if (event.type === 'tool_result') {
      const truncated = event.content.length > 500
        ? event.content.slice(0, 500) + '...'
        : event.content;
      textParts.push(`${truncated}\n`);
    } else if (event.type === 'done') {
      // Cost/duration stored in DB, not shown inline
    }
  }

  // If we extracted text, return it; otherwise return raw log
  if (textParts.length > 0) {
    return textParts.join('');
  }

  return rawLog;
}

export function updateJob(job: JobData): void {
  saveToDb(job);
}

// Memoize verdict per finished review job. Once a job is finalized its log
// is immutable, so the verdict can't change. /api/jobs polling (every 5 s)
// and the per-row jobToDict were re-reading every review log file from disk
// + re-parsing stream-json on every request — driving the dev server CPU
// to ~800% with hundreds of historical review jobs.
const verdictCache = new Map<string, string | null>();

export function getVerdict(job: JobData): string | null {
  if (job.kind !== 'review' || job.finishedAt === null) return null;
  const cached = verdictCache.get(job.id);
  if (cached !== undefined) return cached;
  const v = computeVerdict(job);
  verdictCache.set(job.id, v);
  return v;
}

function computeVerdict(job: JobData): string | null {
  // Use parsed log — raw stream-json encodes newlines as literal "\n",
  // which breaks word boundaries and masks a trailing verdict token.
  const log = readParsedLog(job, 100_000);
  if (!log) return null;
  // The real verdict is always near the end of the output. Search only the
  // tail to avoid matching code snippets like `verdict === 'LGTM'` or the
  // review prompt's own "Verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP"
  // instructions further up in the log.
  const tail = log.slice(-2000);
  // Multi-line "Verdict\n**X**" form: "Verdict" header followed by a token
  // within a short window of non-alpha characters (whitespace, punctuation,
  // markdown bold, list markers).
  // Reject matches where the verdict is immediately followed by "/" — that's
  // the prompt's own "LGTM / NEEDS ATTENTION / DO NOT SHIP" listing, not a
  // decision.
  const multiline = [...tail.matchAll(/[Vv]erdict[^A-Za-z]{1,80}?(LGTM|NEEDS ATTENTION|DO NOT SHIP)(?![*_` ]*\s*\/)/g)];
  if (multiline.length > 0) return multiline[multiline.length - 1][1];
  // Fallback: scan the final non-empty lines for a verdict token at the
  // start (with optional markdown decoration) followed by either end-of-line
  // or a separator like " — ", ":", " -" introducing a one-line rationale.
  // Accepts bare `LGTM`, `**LGTM**`, `LGTM — summary`, `LGTM: summary`, etc.
  // Rejects `LGTM / NEEDS ATTENTION / DO NOT SHIP` (the prompt's own enum)
  // because that line has a "/" right after the token.
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const lineTokenRe = /^[*_` ]*(LGTM|NEEDS ATTENTION|DO NOT SHIP)[*_` ]*(?:\s*[-–—:]|\s*$)(?![*_` ]*\s*\/)/;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = lineTokenRe.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

export function jobToDict(job: JobData): Record<string, unknown> {
  const d: Record<string, unknown> = {
    id: job.id,
    project: job.project,
    kind: job.kind,
    prompt: job.prompt,
    pid: job.pid,
    log_path: job.logPath,
    status: job.finishedAt !== null ? 'done' : 'running',
    exit_code: job.exitCode,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    seen: job.seen,
    duration_ms: job.durationMs,
    input_tokens: job.inputTokens,
    output_tokens: job.outputTokens,
    cache_read_tokens: job.cacheReadTokens,
    cache_create_tokens: job.cacheCreateTokens,
    session_id: job.sessionId,
    context_meta: job.contextMeta ?? null,
    user_prompt: job.userPrompt ?? null,
    cost_usd: job.costUsd ?? null,
    model: job.model ?? null,
    gh_issue_number: job.ghIssueNumber ?? null,
    gh_issue_repo: job.ghIssueRepo ?? null,
    gh_issue_title: job.ghIssueTitle ?? null,
  };
  d.log_pruned = job.logPruned ?? false;
  const verdict = getVerdict(job);
  if (verdict !== null) d.verdict = verdict;
  return d;
}

function logHasClaudeResult(job: JobData): boolean {
  if (!job.logPath || !existsSync(job.logPath)) return false;
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    return content.includes('"type":"result"');
  } catch {
    return false;
  }
}

export async function probeJobStatus(job: JobData): Promise<'running' | 'done'> {
  if (job.finishedAt !== null) {
    // Belt-and-braces: /api/jobs polls probeJobStatus frequently; use those
    // ticks to reconcile any stranded release whose children are all done.
    // Cheap (one listJobs filter) and no-op when the release has already
    // been finalized by the normal path.
    await reconcileStaleRelease(job);
    return 'done';
  }
  // Jobs are created with pid=0 and the real pid is persisted asynchronously
  // after `pm2 start` returns (can take up to pm2's 15 s timeout). During that
  // window, treat the job as still spawning rather than dead — otherwise a
  // concurrent probe (e.g. the duplicate-check in /api/agents/[id]/run) would
  // markDone(-1) mid-spawn AND pm2-delete the nascent Claude process, leaving
  // a phantom `exit -1 @ 0s` row. Grace is intentionally generous because
  // `pm2 start` worst-case is ~15 s plus slack for the server's main loop.
  const PID_SPAWN_GRACE_SEC = 30;
  if (job.pid <= 0) {
    const ageSec = Date.now() / 1000 - job.startedAt;
    if (ageSec < PID_SPAWN_GRACE_SEC) return 'running';
    // Non-PM2 kinds (test/action) have no name to look up in pm2 — dead means dead.
    if (job.kind === 'test' || job.kind === 'action') {
      await markDone(job, -1);
      return 'done';
    }
    // PM2-managed kinds: a race between `pm2 start` returning and `pm2 jlist`
    // reflecting the new process can leave job.pid=0 even though pm2 knows
    // about the job by name. Ask pm2 directly before declaring it dead —
    // otherwise we incorrectly markDone(-1) long-running jobs (classic
    // symptom: release jobs ending with exit_code=-1 despite the pipeline
    // succeeding and writing `# release finished — exit 0`).
    const { status, exitCode } = await getJobStatus(job.id);
    if (status === 'running') {
      // Opportunistically backfill pid so subsequent probes skip this path.
      try {
        const realPid = await (await import('./pm2-jobs')).getJobPid(job.id);
        if (realPid && realPid > 0) {
          job.pid = realPid;
          saveToDb(job);
        }
      } catch {}
      return 'running';
    }
    if (status === 'done') {
      await markDone(job, exitCode ?? -1);
      return 'done';
    }
    // status === 'unknown' — pm2 truly has no record of the job. It's dead.
    await markDone(job, -1);
    return 'done';
  }
  // Claude CLI sometimes hangs after emitting its final result event (stop_reason
  // = end_turn, is_error = false, but the process never exits — most often seen on
  // long agent runs). If the log already contains a terminal result line, treat
  // the job as done regardless of PM2 status. Applies to every claude-backed kind.
  const claudeKind = job.kind === 'run'
    || job.kind === 'review'
    || job.kind === 'fix'
    || job.kind === 'fix-ci'
    || job.kind === 'fix-push'
    || job.kind.startsWith('agent:');
  if (claudeKind && logHasClaudeResult(job)) {
    await markDone(job, 0);
    return 'done';
  }
  // Test/action jobs spawn directly (no PM2) — check liveness via pid only.
  if (job.kind === 'test' || job.kind === 'action') {
    try {
      process.kill(job.pid, 0);
      return 'running';
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
      await markDone(job, -1);
      return 'done';
    }
  }
  const { status, exitCode } = await getJobStatus(job.id);
  if (status === 'running') return 'running';
  if (status === 'done') {
    await markDone(job, exitCode ?? -1);
    return 'done';
  }
  try {
    process.kill(job.pid, 0);
    return 'running';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return 'running';
    await markDone(job, -1);
    return 'done';
  }
}

export function createJob(
  project: string,
  kind: string,
  pid: number,
  logPath: string,
  prompt?: string,
  contextMeta?: string,
  userPrompt?: string,
  ghIssueNumber?: number | null,
  ghIssueRepo?: string | null,
  ghIssueTitle?: string | null,
): JobData {
  loadFromDb();
  let timestamp = Math.floor(Date.now() * 1000);
  let jobId = `${project}-${kind}-${timestamp}`;
  while (jobsCache.has(jobId)) {
    timestamp += 1;
    jobId = `${project}-${kind}-${timestamp}`;
  }
  const job: JobData = {
    id: jobId,
    project,
    kind,
    prompt: prompt || null,
    pid,
    logPath,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    contextMeta: contextMeta ?? null,
    userPrompt: userPrompt ?? null,
    ghIssueNumber: ghIssueNumber ?? null,
    ghIssueRepo: ghIssueRepo ?? null,
    ghIssueTitle: ghIssueTitle ?? null,
  };
  jobsCache.set(jobId, job);
  saveToDb(job);
  return job;
}

export function getJob(jobId: string): JobData | null {
  loadFromDb();
  const cached = jobsCache.get(jobId);
  if (cached) return cached;
  const row = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  if (!row) return null;
  const job: JobData = {
    id: row.id,
    project: row.project,
    kind: row.kind,
    prompt: row.prompt ?? null,
    pid: row.pid,
    logPath: row.logPath,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    exitCode: row.exitCode ?? null,
    seen: row.seen ?? false,
    durationMs: row.durationMs ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheCreateTokens: row.cacheCreateTokens ?? null,
    sessionId: row.sessionId ?? null,
    contextMeta: row.contextMeta ?? null,
    userPrompt: row.userPrompt ?? null,
    ghIssueNumber: row.ghIssueNumber ?? null,
    ghIssueRepo: row.ghIssueRepo ?? null,
    ghIssueTitle: row.ghIssueTitle ?? null,
    logPruned: row.logPruned ?? false,
    costUsd: row.costUsd ?? null,
    model: row.model ?? null,
  };
  jobsCache.set(jobId, job);
  return job;
}

export function listJobs(): JobData[] {
  loadFromDb();
  return Array.from(jobsCache.values());
}

export function unseenFinished(): JobData[] {
  loadFromDb();
  return Array.from(jobsCache.values()).filter(
    (j) => j.finishedAt !== null && !j.seen
  );
}

export function markSeen(jobId: string): boolean {
  const job = jobsCache.get(jobId);
  if (!job) return false;
  job.seen = true;
  saveToDb(job);
  return true;
}
