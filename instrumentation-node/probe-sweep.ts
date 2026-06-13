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
