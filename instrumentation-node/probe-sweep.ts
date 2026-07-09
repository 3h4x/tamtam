// `reinstallAgents()` and the in-memory scheduler it armed were retired
// when graphile-cron took over (see `seedAgentCrons` + `startCronWorker`
// in instrumentation-node.ts). Scheduled agents are now durable across
// restarts via graphile-worker's persistent job queue.

// Periodic probe sweep. Two responsibilities, both orthogonal to the
// release pipeline orchestration:
//
//   1. Claude CLI sometimes hangs after emitting its final result event.
//      `probeJobStatus` can detect this via the log's terminal result line,
//      but only when *something* polls. The sweep is that something.
//   2. Releases that blow past `releaseDeadlineAt` need to be aborted.
//
// The hook-failure recovery patterns (stale release reconcile, queued-agent
// drain, generic reconcile sweep, auto-resume of stuck releases, quota
// drain) used to live here too. They were removed when the workflow runtime
// became the only release path — its durability owns those concerns now.
export async function runProbeSweep(): Promise<void> {
  // ── Host-protection section: runs UNCONDITIONALLY, even during a DB outage ──
  // These three find a hung/runaway process from in-memory job state and kill
  // its process group (a pure `process.kill(-pid)`); only their trailing
  // `markDone` touches the DB and is already best-effort. Gating them on DB
  // reachability would let a runaway (e.g. a libuv-busy-looping Vitest worker)
  // burn a core for the *entire* outage — the exact failure they exist to
  // prevent — so they must precede the reachability gate below.
  try {
    const jobStorage = await import('@/lib/jobs/job-storage');
    const { isClaudeBackedJobKind, getJobKind } = await import('@/lib/jobs/kinds');
    const pipelineStepKinds = 'PIPELINE_STEP_KINDS' in jobStorage && jobStorage.PIPELINE_STEP_KINDS instanceof Set
      ? jobStorage.PIPELINE_STEP_KINDS
      : new Set<string>();
    const running = jobStorage.listJobs().filter((job) => {
      try {
        const kind = getJobKind(job?.kind);
        return job?.finishedAt === null
          && (isClaudeBackedJobKind(kind) || pipelineStepKinds.has(kind));
      } catch {
        return false;
      }
    });
    for (const job of running) {
      try { await jobStorage.probeJobStatus(job); } catch {}
    }
  } catch (err) {
    console.error('[probe-sweep] error:', err);
  }
  // Reap detached jobs (test + mark-dod-verify) that blew past their wall-clock
  // cap. A forked Vitest worker can libuv-busy-loop forever (unclosed IPC fd),
  // so `pnpm test` never exits and start-test's `proc.on('close')` never fires;
  // a hung Claude verify never emits a result line. A restart orphans the
  // detached group to PID 1, where it burns a core indefinitely. Reading job
  // rows (not an in-process timer) means this still fires after a restart — the
  // single, restart-safe liveness guard for all detached job kinds.
  try {
    const { reapTimedOutClaudeJobs } = await import('@/lib/jobs/test-timeout-reaper');
    await reapTimedOutClaudeJobs();
  } catch (err) {
    console.error('[probe-sweep] job timeout reap error:', err);
  }
  // Per-run runaway guard: kill Claude runs/agents that blew past the token or
  // wall-time cap before a project-level budget check would ever fire. No-op
  // when both caps are disabled. Reads log rows so it survives a restart.
  try {
    const { reapRunCapExceededJobs } = await import('@/lib/jobs/run-cap-reaper');
    await reapRunCapExceededJobs();
  } catch (err) {
    console.error('[probe-sweep] run-cap reap error:', err);
  }

  // ── Reachability gate ──────────────────────────────────────────────────────
  // Everything below is pure DB-recovery/reconcile/drain work: it can accomplish
  // nothing while Postgres is unreachable and, unlike the host-protection section
  // above, it fires DB queries every tick regardless of whether there is work to
  // do — so on an outage it was the source of the ~14 `AggregateError` stacks per
  // 30 s tick that buried the real "DB is down" condition. Probe once; if the DB
  // is down, skip this section and let the gate emit a single throttled signal
  // instead of hammering a dead pool. The gate probes a dedicated connection (not
  // the shared app pool), so pool saturation under load can never masquerade as
  // an outage and disable these safety nets. The next tick catches up the moment
  // Postgres returns.
  const { ensureDbReachable } = await import('@/lib/db/reachability');
  if (!(await ensureDbReachable())) return;
  // Heal zombie rows: jobs the in-memory cache already marked finished but whose
  // `finished_at` DB write was dropped (DB unreachable at finalize). The probe
  // above can't catch these — it only re-probes cache-running jobs — so a stale
  // DB row would otherwise pin the durable agent-run slot and 409-block the
  // agent forever. Runs every sweep + once at boot.
  try {
    const { reconcileFinishedDbRows } = await import('@/lib/jobs/finished-row-reconcile');
    await reconcileFinishedDbRows();
  } catch (err) {
    console.error('[probe-sweep] finished-row reconcile error:', err);
  }
  try {
    const jobStorage = await import('@/lib/jobs/job-storage');
    const { abortActiveRelease } = await import('@/lib/pipeline/release-abort');
    const now = Date.now();
    const expiredReleases = jobStorage.listJobs().filter(j =>
      j.kind === 'release'
      && j.finishedAt === null
      && typeof j.releaseDeadlineAt === 'number'
      && j.releaseDeadlineAt > 0
      && j.releaseDeadlineAt < now
    );
    for (const release of expiredReleases) {
      try {
        await abortActiveRelease(release.project, {
          reason: 'wall_clock_timeout',
          targetReleaseId: release.id,
        });
      } catch (err) {
        console.error(`[probe-sweep] release timeout abort failed for ${release.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[probe-sweep] release timeout sweep error:', err);
  }
  try {
    const { runReleaseReconcileSweep } = await import('@/lib/jobs/release-reconcile');
    await runReleaseReconcileSweep();
  } catch (err) {
    console.error('[probe-sweep] release reconcile sweep error:', err);
  }
  // Drain unconsumed job_completion_events. The inline completion-hook
  // chain (in lib/jobs/lifecycle.ts) handles the happy path; this drain is
  // the safety net for crashes/restarts between markDone's event insert
  // and the hook return.
  try {
    const { consumeJobCompletionEvents } = await import('@/lib/workflows/triggers/job-completion-router');
    await consumeJobCompletionEvents();
  } catch (err) {
    console.error('[probe-sweep] job-completion-router error:', err);
  }
  try {
    const { consumePipelineLockEvents } = await import('@/lib/workflows/triggers/pipeline-lock-router');
    await consumePipelineLockEvents();
  } catch (err) {
    console.error('[probe-sweep] pipeline-lock-router error:', err);
  }
  try {
    const { sampleRunningJobResources } = await import('@/lib/jobs/resource-sampler');
    await sampleRunningJobResources();
  } catch (err) {
    console.error('[probe-sweep] resource-sampler error:', err);
  }
  try {
    const { reconcileStrandedBranches } = await import('@/lib/jobs/stranded-branch-reconcile');
    await reconcileStrandedBranches();
  } catch (err) {
    console.error('[probe-sweep] stranded-branch reconcile error:', err);
  }
  // Auto-disable caught-up / unfruitful producer agents: agents whose own
  // recent scheduled runs produce no value while the project and healthy
  // sibling agents keep running. No-op when the setting is off.
  try {
    const { runUnfruitfulPauseSweep } = await import('@/lib/orchestrator/unfruitful-pause');
    await runUnfruitfulPauseSweep();
  } catch (err) {
    console.error('[probe-sweep] unfruitful-pause error:', err);
  }
  // Self-heal circuit-breaker pauses whose failures a later successful run
  // proved resolved: resume the project so the stale `project_paused` HITL
  // clears instead of nagging forever. Scoped to breaker pauses; re-trips on its
  // own if failures resume. No-op when nothing is breaker-paused.
  try {
    const { runCircuitBreakerAutoResumeSweep } = await import('@/lib/pipeline/circuit-breaker-resume');
    await runCircuitBreakerAutoResumeSweep();
  } catch (err) {
    console.error('[probe-sweep] circuit-breaker auto-resume error:', err);
  }
  // Safety net: re-fire orphaned pending releases. A pending release normally
  // drains on a pipeline-lock-release event or at boot. If neither fires — the
  // holding pipeline emitted no release event, or the release was queued after
  // the last event already drained — it strands with a free lock and nothing to
  // retrigger it (observed stranded 50+ min). This mirrors the queued-agent
  // safety net below, which was already added for the same class of missed-event
  // stall but never extended to pending releases. drainProjectRecoveryWork is
  // single-flight and drainPendingRelease self-guards (no-op when a release is
  // already running, re-queue on benign conflicts), so it is cheap, idempotent,
  // and preserves the release-before-agents invariant per project.
  try {
    const { listPendingReleaseProjects } = await import('@/lib/pipeline/pending-release');
    const { drainProjectRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    for (const project of await listPendingReleaseProjects()) {
      void drainProjectRecoveryWork(project, '[probe-sweep recovery]');
    }
  } catch (err) {
    console.error('[probe-sweep] pending-release recovery error:', err);
  }
  // Safety net: drain in-memory agent queues for projects where nothing is
  // currently running. The primary drain path is the lifecycle hook that fires
  // drainNextAgentRun on every agent finish. But a race between the drain and
  // a concurrent agent start (e.g. boost claiming startingAgents before the
  // lifecycle check) causes the drain to return early without scheduling a
  // retry, leaving the queue stuck indefinitely. This sweep fires every 30 s —
  // cheap, idempotent (inFlight + hasAgentStartSlot guards in drainNextAgentRun
  // prevent re-entrant drains).
  try {
    const { listQueuedProjects, drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    const { listJobs } = await import('@/lib/jobs/job-storage');
    const { isAgentJobKind } = await import('@/lib/jobs/kinds');
    const runningProjects = new Set(
      listJobs()
        .filter((j) => j?.finishedAt === null && isAgentJobKind(j?.kind))
        .map((j) => j.project),
    );
    for (const project of listQueuedProjects()) {
      if (!runningProjects.has(project)) {
        void drainNextAgentRun(project);
      }
    }
  } catch (err) {
    console.error('[probe-sweep] stalled-queue drain:', err);
  }
}
