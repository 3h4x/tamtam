import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { parseStreamLines } from '@/lib/jobs/claude-stream-parser';
import { costUsd } from '@/lib/shared/usage-pricing';
import { readLog } from '@/lib/jobs/verdict';
import { saveToDbAsync, awaitInFlightSave, jobsCache } from '@/lib/jobs/storage';
import type { JobData } from '@/lib/jobs/types';
import { isAgentJobKind, isClaudeBackedJobKind } from '@/lib/jobs/kinds';
import { computeRunScore } from '@/lib/agents/run-score';
import { shouldAutoMarkSeen } from '@/lib/jobs/lifecycle-helpers';
import { runCompletionHooks } from './completion-hooks';

export async function markDone(job: JobData, exitCode: number): Promise<void> {
  // Idempotent: if already finalized, don't double-fire hooks or rewrite DB.
  if (job.finishedAt !== null) return;
  await awaitInFlightSave(job.id);

  // Extract result metadata (tokens, duration, session) from log.
  // NOTE: we skip this for `release` meta-jobs. Their log is an aggregate of
  // child logs, so parseStreamLines would find the *child's* session_id and
  // falsely assign it to the release — later the UI would treat release +
  // review as the same session, merge them, and shrink the release's
  // apparent window (hiding commit/push from release grouping).
  const shouldExtractMetadata = job.kind !== 'release';
  const rawLog = shouldExtractMetadata ? readLog(job, 50_000) : '';
  const events = shouldExtractMetadata ? parseStreamLines(rawLog) : [];
  job.exitCode = exitCode;
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
    const isClaudeKind = isClaudeBackedJobKind(job.kind);
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

  const finishedAt = Date.now() / 1000;
  const previousFinishedAt = job.finishedAt;
  job.finishedAt = finishedAt;
  if (isAgentJobKind(job.kind) || (job.kind === 'run' && job.ghIssueNumber != null)) {
    try {
      const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
      await finalizeAgentRunReport(job, rawLog);
    } catch (e) {
      console.log(`[job ${job.id}] failed to finalize agent run report:`, e);
    }
  } else if (
    (job.kind === 'review' || job.kind === 'fix' || job.kind === 'fix-ci') &&
    rawLog &&
    !job.workSummary
  ) {
    // LLM-driven steps emit a final summary of what they found/changed. Capture
    // it the same way agents do so the History row's title says what the review
    // or fix actually did instead of a generic "Code review" / "Auto-fix" label.
    try {
      const { extractAssistantTextFromRawLog, extractWorkSummary } = await import(
        '@/lib/agents/work-summary-extractor.mjs'
      );
      const { summary } = extractWorkSummary(extractAssistantTextFromRawLog(rawLog));
      if (summary) job.workSummary = summary;
    } catch (e) {
      console.log(`[job ${job.id}] failed to extract step summary:`, e);
    }
  }

  job.runScore = computeRunScore({
    exitCode: job.exitCode,
    modifiedFiles: job.modifiedFiles ?? null,
    linesAdded: job.linesAdded ?? null,
    linesRemoved: job.linesRemoved ?? null,
    workSummary: job.workSummary ?? null,
  });

  // Claim the DB row and emit the durable completion event in one transaction.
  // This preserves the crash-recovery invariant: once `jobs.finished_at` is
  // visible, the event router also has a row it can replay after restart. Agent
  // report fields are included in the same write so replay consumers see the
  // same shippable-change and fruitfulness signal as inline hooks.
  let claimedRows: { finishedAt: number | null; exitCode: number | null }[];
  try {
    claimedRows = await db.transaction(async (tx) => {
      const rows = await tx.update(schema.jobs)
        .set({
          finishedAt,
          exitCode: job.exitCode,
          durationMs: job.durationMs ?? null,
          inputTokens: job.inputTokens ?? null,
          outputTokens: job.outputTokens ?? null,
          cacheReadTokens: job.cacheReadTokens ?? null,
          cacheCreateTokens: job.cacheCreateTokens ?? null,
          sessionId: job.sessionId ?? null,
          model: job.model ?? null,
          costUsd: job.costUsd ?? null,
          ghIssueNumber: job.ghIssueNumber ?? null,
          workSummary: job.workSummary ?? null,
          modifiedFiles: job.modifiedFiles ?? null,
          linesAdded: job.linesAdded ?? null,
          linesRemoved: job.linesRemoved ?? null,
          runScore: job.runScore ?? null,
        })
        .where(and(eq(schema.jobs.id, job.id), isNull(schema.jobs.finishedAt)))
        .returning({ finishedAt: schema.jobs.finishedAt, exitCode: schema.jobs.exitCode });
      if (rows.length > 0) {
        await tx.insert(schema.jobCompletionEvents).values({
          jobId: job.id,
          kind: job.kind,
          exitCode: job.exitCode,
          project: job.project,
          releaseId: job.releaseId ?? null,
          ghIssueNumber: job.ghIssueNumber ?? null,
          emittedAt: finishedAt,
        }).onConflictDoNothing({ target: schema.jobCompletionEvents.jobId }).execute();
        return rows;
      }

      const insertedRows = await tx.insert(schema.jobs).values({
        id: job.id,
        project: job.project,
        kind: job.kind,
        prompt: job.prompt,
        pid: job.pid,
        logPath: job.logPath,
        startedAt: job.startedAt,
        finishedAt,
        exitCode: job.exitCode,
        seen: job.seen,
        durationMs: job.durationMs ?? null,
        inputTokens: job.inputTokens ?? null,
        outputTokens: job.outputTokens ?? null,
        cacheReadTokens: job.cacheReadTokens ?? null,
        cacheCreateTokens: job.cacheCreateTokens ?? null,
        sessionId: job.sessionId ?? null,
        contextMeta: job.contextMeta ?? null,
        userPrompt: job.userPrompt ?? null,
        parentJobId: job.parentJobId ?? null,
        ghIssueNumber: job.ghIssueNumber ?? null,
        ghIssueRepo: job.ghIssueRepo ?? null,
        ghIssueTitle: job.ghIssueTitle ?? null,
        logPruned: job.logPruned ?? false,
        verdict: job.verdict ?? null,
        costUsd: job.costUsd ?? null,
        model: job.model ?? null,
        releaseId: job.releaseId ?? null,
        abortedAt: job.abortedAt ?? null,
        releaseDeadlineAt: job.releaseDeadlineAt ?? null,
        promptBytes: job.promptBytes ?? null,
        workSummary: job.workSummary ?? null,
        modifiedFiles: job.modifiedFiles ?? null,
        linesAdded: job.linesAdded ?? null,
        linesRemoved: job.linesRemoved ?? null,
        provider: job.provider ?? null,
        runScore: job.runScore ?? null,
      }).onConflictDoNothing({ target: schema.jobs.id })
        .returning({ finishedAt: schema.jobs.finishedAt, exitCode: schema.jobs.exitCode });
      if (insertedRows.length === 0) return insertedRows;
      await tx.insert(schema.jobCompletionEvents).values({
        jobId: job.id,
        kind: job.kind,
        exitCode: job.exitCode,
        project: job.project,
        releaseId: job.releaseId ?? null,
        ghIssueNumber: job.ghIssueNumber ?? null,
        emittedAt: finishedAt,
      }).onConflictDoNothing({ target: schema.jobCompletionEvents.jobId }).execute();
      return insertedRows;
    });
  } catch (e) {
    job.finishedAt = previousFinishedAt;
    throw e;
  }
  if (claimedRows.length === 0) {
    const dbRows = await db
      .select({ finishedAt: schema.jobs.finishedAt, exitCode: schema.jobs.exitCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .limit(1);
    const dbRow = dbRows[0] ?? null;
    if (dbRow?.finishedAt != null) {
      job.finishedAt = dbRow.finishedAt;
      job.exitCode = dbRow.exitCode ?? job.exitCode;
      return;
    }
  }
  if (shouldAutoMarkSeen(job)) job.seen = true;
  // Sync the in-memory cache with the finalized state. Pipeline phases (e.g.
  // pr-wait) finalize inside the workflow runtime on a job object that may not
  // be the cached reference, so without this `listJobs()` keeps serving a row
  // with `finishedAt: null` and stale `contextMeta` even though the DB is done
  // — which made the inbox's HITL "PR needs manual merge" signal silently
  // never fire for a deferred (risky_diff) PR.
  jobsCache.set(job.id, job);
  await saveToDbAsync(job);
  void db.delete(schema.ghIssuesCache).where(eq(schema.ghIssuesCache.project, job.project)).execute().catch(() => {});
  // Wrap completion hooks so a thrown handler can't strand the release
  // meta-job in `running`. The orchestrator workflow finalizes the meta-job
  // when its dispatch result is terminal; we just log here.
  try {
    await runCompletionHooks(job);
  } catch (hookErr) {
    console.error(`[markDone] completion hooks threw for ${job.id}:`, hookErr);
  }
  // Fallback: explicitly SIGKILL the bash wrapper and any children in case
  // the spawned subprocess hung after Claude CLI's final result event.
  // Skip when job.pid is the server's own process.pid — killing it would
  // SIGKILL TamTam itself and cascade -1 exits onto every other in-flight
  // job. Multiple kinds use this convention (push, commit, release,
  // inline-agent before/around Claude child capture), so detect by PID
  // equality rather than enumerating kinds — the enumeration drifted out of
  // sync and was the cause of TamTam self-killing on inline-agent /
  // release-meta job completion. mark-dod and pr-wait already use pid=0
  // and never reach this branch.
  const isInlineServerKind = job.pid === process.pid;
  // Refuse to operate on system PIDs. macOS reserves 1–99 for daemons; PID 1 is
  // launchd, whose children include every user GUI app. A bad job.pid value
  // from a corrupt DB row or a misbehaving spawner would otherwise SIGKILL
  // Finder / Dock / the running terminal — observed during a unit test that
  // accidentally passed pid=1. A legitimate tamtam-spawned process always has
  // pid > 100 in practice.
  const SAFE_PID_FLOOR = 100;
  if (job.pid > SAFE_PID_FLOOR && !isInlineServerKind) {
    try {
      const { exec } = await import('@/lib/shared/shell');
      const { stdout } = await exec('pgrep', ['-P', String(job.pid)], { timeout: 2000 });
      const children = stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
      const pids = [job.pid, ...children];
      const alive: number[] = [];
      for (const pid of pids) {
        if (pid <= SAFE_PID_FLOOR) continue;
        try {
          process.kill(pid, 'SIGKILL');
          alive.push(pid);
        } catch {}
      }
      if (alive.length > 0) {
        console.log(`[job ${job.id}] force-killed hung process(es) after completion: ${alive.join(', ')}`);
      }
    } catch {}
  } else if (job.pid > 0 && job.pid <= SAFE_PID_FLOOR) {
    console.warn(`[job ${job.id}] refusing to clean up suspicious pid=${job.pid} (system PID range); kind=${job.kind}`);
  }
}
