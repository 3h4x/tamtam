import {
  armWorkflowReadyWatchdog,
  backfillVerdicts,
  drainBootRecoveryWork,
  migrateLegacyFileWorkflowFlags,
  reapAbandonedInlineJobs,
  reapOrphanReleases,
  signalWorkflowReady,
  waitForWorkflowReady,
} from '@/instrumentation-node/boot-recovery';
import { runProbeSweep } from '@/instrumentation-node/probe-sweep';

export { drainStalePendingReleases, reapOrphanReleases, waitForWorkflowReady } from '@/instrumentation-node/boot-recovery';
export { runProbeSweep } from '@/instrumentation-node/probe-sweep';

export async function registerNode(): Promise<void> {
  try {
    const { getSettings, initSettings } = await import('@/lib/shared/config');
    await initSettings();
    if (!getSettings().auth_token_configured) {
      console.warn('[auth] TamTam is running without auth — only safe on localhost');
    }
  } catch (err) {
    console.warn('[auth] startup auth check failed:', err);
  }
  await migrateLegacyFileWorkflowFlags();
  try {
    const { loadFromDb } = await import('@/lib/jobs/storage');
    await loadFromDb();
  } catch (err) {
    console.error('[boot] jobs cache load failed:', err);
  }
  // Warm the projects cache before any worker / cron / pipeline step
  // tries to resolve a project path. Cold cache returns null which
  // surfaces as "project 'X' not found" from start-test / start-review,
  // failing the workflow run and orphaning the release.
  try {
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await refreshProjectsCacheSync();
  } catch (err) {
    console.error('[boot] projects cache warm failed:', err);
  }
  try {
    const { backfillIssueCruncherPrerequisites } = await import('@/lib/agents/default-agent-skills');
    await backfillIssueCruncherPrerequisites();
  } catch (err) {
    console.error('[boot] issue-cruncher prerequisite backfill failed:', err);
  }
  void backfillVerdicts();
  try {
    const { startSystemMetricsSampler } = await import('@/lib/shared/system-metrics');
    startSystemMetricsSampler();
  } catch (err) {
    console.error('[boot] system-metrics sampler start failed:', err);
  }
  const inlineReapPromise = reapAbandonedInlineJobs();
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    await inlineReapPromise;
  } else {
    void inlineReapPromise;
  }
  // reapOrphanReleases + drainBootRecoveryWork must NOT run until the
  // workflow world has finished starting and re-enqueued its persisted
  // runs. A fixed setTimeout(8000) was insufficient because
  // workflow-postgres-setup can take longer than 8s on cold boot — the
  // reaper would then mark healthy mid-flight releases as orphan exit=-1
  // a beat before the orchestrator would have picked them back up. Gate
  // on the explicit workflow-ready signal. A watchdog logs slow starts, but
  // it does not unblock destructive recovery: if the world is configured and
  // still starting, reaping is more dangerous than waiting.
  const bootRecoveryPromise = (async () => {
    try {
      await waitForWorkflowReady();
    } catch (err) {
      console.warn('[boot] workflow-ready wait failed; running reap anyway:', err);
    }
    await reapOrphanReleases();
    await drainBootRecoveryWork();
  })();
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) {
    void bootRecoveryPromise;
  }
  // reinstallAgents() retired with the in-memory scheduler — graphile-cron
  // (`seedAgentCrons` below) replaces it. Scheduled agents are durable
  // across restarts via graphile-worker's persistent job queue now.

  // One-shot probe at boot so we don't wait up to 30s for the first
  // interval tick to detect a Claude CLI process that hung before the
  // restart, or a release that already crossed its deadline.
  const probeSweepPromise = runProbeSweep();
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    await probeSweepPromise;
  } else {
    void probeSweepPromise;
  }

  // Start Ollama via PM2 when retrieval is enabled
  try {
    const { getSettings: _getCfg } = await import('@/lib/shared/config');
    const _cfg = _getCfg();
    if (_cfg.retrieval_enabled) {
      const { ensureOllamaRunning } = await import('@/lib/agents/retrieval/ollama-lifecycle');
      void ensureOllamaRunning({
        ollamaUrl: _cfg.retrieval_ollama_url,
        embeddingModel: _cfg.retrieval_embedding_model,
        manageOllama: _cfg.retrieval_manage_ollama,
      }).catch((err) => console.warn('[retrieval] Ollama lifecycle error:', err));
    }
  } catch (err) {
    console.warn('[retrieval] boot check failed:', err);
  }

  // Arm the watchdog before workflow startup awaits that might block. The
  // watchdog is intentionally log-only; startup success/failure is the only
  // signal that can release destructive boot recovery.
  armWorkflowReadyWatchdog();

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    // Tests don't start the world; let waiters proceed immediately.
    signalWorkflowReady();
    await bootRecoveryPromise;
    return;
  }

  // No world configured — boot reap can proceed immediately without
  // waiting for a world that's never going to start.
  if (!process.env.WORKFLOW_TARGET_WORLD) {
    signalWorkflowReady();
  }

  // Start workflow world (Postgres-backed durable orchestration). The world
  // is required for the only agent intake path; if WORKFLOW_TARGET_WORLD is
  // unset or the world fails to start, agent runs will fail when the route
  // tries to enqueue them.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    // Schema migration + Postgres-world bootstrap only run when the
    // operator has *explicitly* set WORKFLOW_POSTGRES_URL — never against
    // DATABASE_URL. Sharing the live app DB with the workflow runtime
    // commingles two unrelated schemas and (worse) lets
    // `workflow-postgres-setup` touch tables it doesn't own. The
    // `WORKFLOW_TARGET_WORLD=local` path doesn't need Postgres at all;
    // skip both the spawn and the env propagation.
    const isPostgresWorld = process.env.WORKFLOW_TARGET_WORLD === 'postgres';
    if (isPostgresWorld && process.env.WORKFLOW_POSTGRES_URL) {
      try {
        const { spawn } = await import('node:child_process');
        const connectionString = process.env.WORKFLOW_POSTGRES_URL;
        await new Promise<void>((resolve) => {
          const child = spawn('pnpm', ['exec', 'workflow-postgres-setup'], {
            cwd: process.cwd(),
            env: { ...process.env, WORKFLOW_POSTGRES_URL: connectionString },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
          child.on('exit', (code) => {
            if (code !== 0) console.warn(`[workflow] schema migration failed (exit ${code}): ${stderr.slice(-500)}`);
            resolve();
          });
          child.on('error', (err) => {
            console.warn('[workflow] schema migration spawn failed:', err);
            resolve();
          });
        });
      } catch (err) {
        console.warn('[workflow] schema migration failed:', err);
      }
    } else if (isPostgresWorld && !process.env.WORKFLOW_POSTGRES_URL) {
      console.warn('[workflow] WORKFLOW_TARGET_WORLD=postgres but WORKFLOW_POSTGRES_URL is not set; workflow runtime will use its built-in default and is unlikely to work — set WORKFLOW_POSTGRES_URL explicitly.');
    }
    try {
      const { getWorld } = await import('workflow/runtime');
      await getWorld().start?.();
      console.log('[workflow] Postgres world started');
    } catch (err) {
      console.warn('[workflow] world failed to start:', err);
    } finally {
      // Whether the world started cleanly or threw, unblock the boot reap.
      // A throwing world can't recover persisted runs anyway, so the
      // reaper claiming orphans is the correct fallback.
      signalWorkflowReady();
    }
  }

  // Nightly DB cleanup: delete job rows older than job_row_retention_days.
  // Once at boot (catches drift from long downtimes); subsequent fires
  // come from the `system-cron` graphile-worker task (see system-cron-task.ts
  // wired below). The bare setInterval(runCleanup, 24h) was retired with
  // the in-memory scheduler — graphile-worker is durable across restarts.
  const runCleanup = async () => {
    try {
      const { runNightlyCleanup } = await import('@/lib/jobs/retention');
      runNightlyCleanup();
      console.log('[retention] nightly cleanup completed');
    } catch (err) {
      console.error('[retention] nightly cleanup error:', err);
    }
    // Also trim the workflow runtime's own traces — the runtime never prunes
    // them, so they grow unbounded without this sweep. The local file-backed
    // world and the Postgres world store traces differently, so prune the
    // one that's actually in use (mutually exclusive by WORKFLOW_TARGET_WORLD).
    try {
      const { getSettings } = await import('@/lib/shared/config');
      const retentionDays = getSettings().workflow_run_retention_days;
      if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
        const { pruneLocalWorldRuns } = await import('@/lib/workflows/local-world-retention');
        const summary = pruneLocalWorldRuns({ retentionDays });
        if (summary.runsDeleted > 0 || summary.errorCount > 0) {
          console.log(`[retention] local workflow trim: runs=${summary.runsDeleted} steps=${summary.stepsDeleted} status=${summary.status}${summary.lastError ? ` err=${summary.lastError}` : ''}`);
        }
      } else {
        const { pruneOldWorkflowRuns } = await import('@/lib/workflows/cron/workflow-retention');
        const summary = await pruneOldWorkflowRuns({ retentionDays });
        if (summary.runsDeleted > 0 || summary.errorCount > 0) {
          console.log(`[retention] workflow trim: runs=${summary.runsDeleted} events=${summary.eventsDeleted} steps=${summary.stepsDeleted} status=${summary.status}${summary.lastError ? ` err=${summary.lastError}` : ''}`);
        }
      }
    } catch (err) {
      console.error('[retention] workflow trim error:', err);
    }
  };
  runCleanup();

  // Phase 4 cron (graphile-worker): always-on now. The in-memory
  // internal-scheduler.ts that ran in parallel during the verification
  // window has been retired in favor of this graphile-worker pool.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    void (async () => {
      try {
        const [
          { seedAgentCrons },
          { seedSystemCron },
          { startCronWorker },
          { SYSTEM_CRON_JOB_KEY },
        ] = await Promise.all([
          import('@/lib/workflows/cron/seed-agent-crons'),
          import('@/lib/workflows/cron/seed-system-cron'),
          import('@/lib/workflows/cron/start-cron-worker'),
          import('@/lib/workflows/cron/system-cron-task'),
        ]);
        const { quickAddJob } = await import('graphile-worker');
        const { listEnabledScheduledAgents } = await import('@/lib/scheduling/internal-scheduler-helpers');

        const connectionString = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
        if (!connectionString) {
          console.warn('[cron] no postgres URL — graphile cron disabled');
          return;
        }

        // Ensure built-in system agents (retrieval-maintenance, …) exist for
        // every enabled project BEFORE the agent-cron seed pass — otherwise
        // they wouldn't be in the list `listEnabledScheduledAgents()`
        // returns, and their cron rows wouldn't be enqueued until the next
        // boot.
        try {
          const { seedSystemAgents } = await import('@/lib/agents/system/seed');
          const r = await seedSystemAgents();
          console.log(`[system-agents] seeded ${r.seeded} new, ${r.skipped} existing, ${r.dismissed} dismissed`);
        } catch (err) {
          console.error('[system-agents] seed failed:', err);
        }

        // Seed enqueues
        const agentSeed = await seedAgentCrons({
          connectionString,
          loadEnabledAgents: listEnabledScheduledAgents,
        });
        const systemSeed = await seedSystemCron({ connectionString });
        console.log(
          `[cron] seeded ${agentSeed.enqueued} agent crons (${agentSeed.preserved} preserved); ` +
            `system-cron: ${systemSeed.enqueued ? 'ok' : systemSeed.reason}`,
        );

        // Start the worker pool with both agent-cron + system-cron handlers
        await startCronWorker({
          connectionString,
          agentCronDeps: {
            loadAgent: async (agentId) => {
              const all = await listEnabledScheduledAgents();
              return all.find((a) => a.id === agentId) ?? null;
            },
            // Skip the fire (without breaking the chain — the cron task
            // re-enqueues itself either way) when global jobs-paused is on
            // or when the project is archived/paused. Each per-agent check
            // is cheap enough to run inline; the cache primed by
            // `listEnabledScheduledAgents` keeps the project lookup free.
            prereqSkipReason: async (agent) => {
              const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
              const skip = (reason: string): string => {
                recordAgentAttempt(agent.id, 'skipped', reason);
                return reason;
              };
              const { isJobsPaused } = await import('@/lib/shared/job-control');
              if (isJobsPaused()) return skip('jobs paused');
              const { isProjectArchived, isProjectPaused } = await import('@/lib/shared/enabled-projects');
              if (isProjectArchived(agent.project)) return skip('project archived');
              if (isProjectPaused(agent.project)) return skip('project paused');
              // Don't pile scheduled work onto an open PR. When the project's
              // HEAD is off the default branch, or a release-pipeline pr-wait
              // is in flight for it, every additional run accumulates on the
              // PR without ever being mergeable in a clean window. Skip until
              // the branch returns to default (PR merged + auto-switched
              // back) — the cron self-reenqueue keeps the schedule ticking.
              try {
                const { listJobs } = await import('@/lib/jobs/job-storage');
                const projectJobs = listJobs().filter(j => j.project === agent.project);
                const prWaitInFlight = projectJobs.some(j => j.kind === 'pr-wait' && j.finishedAt === null);
                if (prWaitInFlight) return skip('pr-wait in flight (awaiting merge)');
                // Release-first workflow: a release fires after every run and
                // must finish (green + pushed) before the next run starts —
                // otherwise each run piles more uncommitted work onto an
                // unshipped tree. Wait while a release pipeline is still in
                // flight for this project.
                const releaseRunning = projectJobs.some(j => j.kind === 'release' && j.finishedAt === null);
                if (releaseRunning) return skip('release pipeline is running');
                const { resolveProjectPath } = await import('@/lib/shared/project-data');
                const projPath = resolveProjectPath(agent.project);
                if (projPath) {
                  const { decidePrContext } = await import('@/lib/pipeline/pr-context');
                  const pr = await decidePrContext(projPath);
                  if (pr.shouldOpenPr) return skip(`on non-default branch '${pr.currentBranch}'`);
                  // Branch-freshness gate: refuse the scheduled fire when the
                  // working branch is behind origin/<default>. The
                  // stranded-branch reconciler is responsible for rebasing /
                  // pushing; the cron just waits it out. Skips the POST so we
                  // don't waste a route call on something the route would 409
                  // on anyway.
                  const { checkBranchFresh } = await import('@/lib/git/branch-freshness');
                  const freshness = await checkBranchFresh(projPath);
                  if (!freshness.fresh) return skip(freshness.reason);
                  // CI-red dispatch gate (opt-in via `ci_gate_block_dispatch_on_red`,
                  // default off): don't spin a new scheduled run onto a project whose
                  // DEFAULT-branch CI is red. `fix-ci` (sweep-dispatched) and manual UI
                  // runs are unaffected, and releases are not gated — so the red branch
                  // can still self-heal and ship. Fails open on a gh error, un-blocks
                  // automatically when CI goes green, and the red state is already
                  // surfaced as the `ci_red` inbox HITL. `system` agents are exempt
                  // (triage/monitoring/report — no diff-producing runs, mirroring the
                  // saturation backoff below): they add no new work to the broken build.
                  if (agent.kind !== 'system') {
                    const { isDefaultBranchCiRed } = await import('@/lib/jobs/ci-dispatch-gate');
                    const ciGate = await isDefaultBranchCiRed(projPath);
                    if (ciGate.red) return skip('default-branch CI is red — deferring scheduled runs until CI is green (see /inbox)');
                  }
                  // Per-agent saturation backoff: a single agent whose target
                  // work is exhausted keeps landing 0-line no-ops while the
                  // project stays active on its OTHER (still-fruitful) agents,
                  // so the project-level auto-pause never fires for it. Skip the
                  // fire while THIS agent is persistently unfruitful AND no new
                  // commit has landed since it last ran (a HEAD move re-enables
                  // it). Reuses the auto-pause-unfruitful settings; system
                  // agents (no diff-producing runs) are exempt.
                  if (agent.kind !== 'system') {
                    const { getSettings } = await import('@/lib/shared/config');
                    const s = getSettings();
                    if (s.auto_pause_unfruitful_enabled && s.auto_pause_unfruitful_rate > 0) {
                      const { isAgentSaturated, recentScheduledRunsForAgent } = await import('@/lib/orchestrator/agent-saturation');
                      const { unfruitfulRateSample } = await import('@/lib/orchestrator/unfruitful-pause');
                      const { isAgentJobKind, getJobKind } = await import('@/lib/jobs/kinds');
                      const sample = unfruitfulRateSample(s.auto_pause_unfruitful_runs);
                      const agentRuns = recentScheduledRunsForAgent(
                        projectJobs, agent.project, `agent:${agent.name}`, isAgentJobKind, getJobKind, sample,
                      );
                      // Only pay for a rev-parse once there is enough history to
                      // possibly be saturated.
                      if (agentRuns.length >= sample) {
                        const { exec } = await import('@/lib/shared/shell');
                        const headR = await exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 });
                        const currentHead = headR.exitCode === 0 ? headR.stdout.trim() : null;
                        if (isAgentSaturated(agentRuns, currentHead, sample, s.auto_pause_unfruitful_rate)) {
                          return skip(`agent saturated (no diff over last ${sample} scheduled runs; HEAD unchanged)`);
                        }
                      }
                    }
                  }
                }
              } catch (err) {
                console.warn(`[cron] branch-state prereq check failed for ${agent.id}:`, err);
              }
              return null;
            },
            startAgentRun: async (agent, modelOverride) => {
              // Mirror the UI's "Run" button: POST { prompt } to the agent
              // run route. The route requires a body prompt (or skill list)
              // and rejects with 400 otherwise. The agent's own prompt is
              // the natural choice; fall back to a synthesized line when an
              // agent has neither prompt nor skills configured.
              //
              // The `x-tamtam-trigger: schedule` header lets the route apply
              // schedule-only guards (skip on non-default branch, refuse
              // disabled/no-schedule agents). Cron also runs prereqSkipReason
              // before this call, so most of those skips fire there first;
              // the header is the safety net.
              //
              // `model` body field is set on orchestrator boost fires when
              // the allocator decided to promote the tier — the route reads
              // it and uses it in place of the agent's stored model.
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const prompt = agent.prompt?.trim() || `Run agent ${agent.name}`;
              const body: Record<string, unknown> = { prompt };
              if (modelOverride) body.model = modelOverride;
              const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.id)}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-tamtam-trigger': 'schedule' },
                body: JSON.stringify(body),
              });
              if (!res.ok) {
                console.warn(`[cron] agent ${agent.id} run POST returned ${res.status}`);
                return null;
              }
              const data = await res.json().catch(() => ({}));
              const jobId = (data?.runId ?? data?.jobId ?? null) as string | null;
              if (res.status === 202) {
                // 202 means the route queued the fire (pipeline_lock,
                // already-running same project, branch state). The fire is
                // not lost — queued_agent_runs / pending-agent-run drain it
                // when the blocker clears — but it didn't actually dispatch
                // a job, so distinguish in telemetry.
                const code = (data?.code ?? data?.status ?? 'queued') as string;
                console.log(`[cron] agent ${agent.id} queued at /run (code=${code})`);
                try {
                  const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
                  recordAgentAttempt(agent.id, 'queued', `queued at /run (${code})`);
                } catch { /* telemetry-only */ }
                return null;
              }
              try {
                const { recordAgentAttempt } = await import('@/lib/scheduling/agent-cron-state');
                recordAgentAttempt(agent.id, 'dispatched', jobId ?? 'started');
              } catch { /* telemetry-only */ }
              return jobId;
            },
            enqueueNextFire: async (agentId, runAt, payloadOverride) => {
              await quickAddJob(
                { connectionString },
                'agent-cron',
                payloadOverride ?? { agentId },
                { jobKey: `agent-cron-${agentId}`, jobKeyMode: 'replace', runAt, maxAttempts: 5 },
              );
            },
            runSystemAgent: async (agent) => {
              const { listJobs, probeJobStatus } = await import('@/lib/jobs/job-storage');
              const { getJobKind } = await import('@/lib/jobs/kinds');
              const kindKey = `agent:${agent.name}`;
              for (const job of listJobs()) {
                if (job.project !== agent.project || getJobKind(job.kind) !== kindKey || job.finishedAt !== null) continue;
                if ((await probeJobStatus(job)) === 'running') {
                  console.warn(`[cron] system agent ${agent.project}/${agent.name} already running as ${job.id} — skipping`);
                  return;
                }
              }
              const { getSystemAgentHandler } = await import('@/lib/agents/system');
              const handler = getSystemAgentHandler(agent.name);
              if (!handler) {
                console.warn(`[cron] system agent ${agent.project}/${agent.name} has no handler — skipping`);
                return;
              }
              await handler.run(agent);
            },
          },
          systemCronDeps: {
            runRetentionCleanup: runCleanup,
            enqueueNextFire: async (runAt) => {
              await quickAddJob(
                { connectionString },
                'system-cron',
                {},
                { jobKey: SYSTEM_CRON_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          projectSweepDeps: {
            runSweep: async () => {
              const { runProjectSweep } = await import('@/lib/jobs/project-sweep-runner');
              await runProjectSweep();
            },
            isEnabled: async () => {
              // Force a fresh DB read — the cron fires every 5min, which is
              // way past the settings cache's 5s TTL. A bare `getSettings()`
              // returns DEFAULTS (with project_sweep_enabled=false) while
              // its background refresh kicks off; the task would then see
              // "disabled" even though the row says true.
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              return !!getSettings().project_sweep_enabled;
            },
            enqueueNextFire: async (runAt) => {
              const { PROJECT_SWEEP_JOB_KEY } = await import('@/lib/workflows/cron/project-sweep-task');
              await quickAddJob(
                { connectionString },
                'project-sweep',
                {},
                { jobKey: PROJECT_SWEEP_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          orchestratorTickDeps: {
            loadConfig: async () => {
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              const s = getSettings();
              if (!s.orchestrator_enabled) return null;
              return {
                marginPct: s.orchestrator_boost_margin_pct,
                maxBoostsPerHour: s.orchestrator_max_boosts_per_hour,
              };
            },
            loadBridge: async () => {
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const res = await fetch(`${baseUrl}/api/stats/bridge`);
              if (!res.ok) throw new Error(`stats/bridge HTTP ${res.status}`);
              return res.json();
            },
            loadAgents: async () => {
              const { listEnabledScheduledAgents } = await import('@/lib/scheduling/internal-scheduler-helpers');
              const { getAllAgentLastDispatches } = await import('@/lib/scheduling/agent-cron-state');
              const { loadAllAgentFruitfulness } = await import('@/lib/agents/fruitfulness');
              const { loadBoostAgents } = await import('@/lib/orchestrator/boost-agent-loader');
              return loadBoostAgents({
                listAgents: listEnabledScheduledAgents,
                getDispatches: getAllAgentLastDispatches,
                loadFruitfulness: () => loadAllAgentFruitfulness({ limit: 10 }),
                onFruitfulnessError: (err) => {
                  console.warn('[orchestrator] fruitfulness load failed; continuing without stats:', err);
                },
              });
            },
            enqueueAgentFire: async (agentId, runAt, modelOverride) => {
              await quickAddJob(
                { connectionString },
                'agent-cron',
                modelOverride ? { agentId, modelOverride } : { agentId },
                { jobKey: `agent-cron-${agentId}`, jobKeyMode: 'replace', runAt, maxAttempts: 5 },
              );
            },
            enqueueNextFire: async (runAt) => {
              const { ORCHESTRATOR_TICK_JOB_KEY } = await import('@/lib/workflows/cron/orchestrator-tick-task');
              await quickAddJob(
                { connectionString },
                'orchestrator-tick',
                {},
                { jobKey: ORCHESTRATOR_TICK_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
            recordBoostRecommendations: async (decisions) => {
              const { upsertRecommendation } = await import('@/lib/recommendations/recommendations');
              await Promise.all(
                decisions.map((d) =>
                  upsertRecommendation({
                    project: d.project,
                    sourceKind: 'orchestrator',
                    sourceId: null,
                    agentId: d.agentId,
                    agentName: d.agentName,
                    type: 'orchestrator_boost',
                    title: d.modelOverride === 'smart'
                      ? `Boosted ${d.agentName} in smart mode`
                      : `Boosted ${d.agentName}`,
                    detail: d.reason,
                    // The extra run was already fired by the time we record it —
                    // this is a done-on-arrival AUTO note, so archive it straight
                    // into History rather than the Unresolved queue.
                    status: 'resolved',
                    payload: {
                      reason: d.reason,
                      modelOverride: d.modelOverride ?? null,
                    },
                  }),
                ),
              );
            },
            analyzeAgentHealth: async (candidates) => {
              const { analyzeAgentHealth } = await import('@/lib/orchestrator/agent-health-analysis');
              return analyzeAgentHealth(candidates);
            },
            runAutopilot: async (outcomes) => {
              const { applyAutopilot } = await import('@/lib/orchestrator/apply-autopilot');
              return applyAutopilot(outcomes);
            },
            loadLatestFinishedRunStartedAt: async (candidate) => {
              const { loadLatestFinishedScheduledRunStartedAt } = await import('@/lib/orchestrator/agent-health-analysis');
              return loadLatestFinishedScheduledRunStartedAt(candidate);
            },
            getProjectQueueCounts: async () => {
              const { listQueuedProjects, listQueuedAgents } = await import('@/lib/agents/pending-agent-run');
              const counts = new Map<string, number>();
              for (const project of listQueuedProjects()) {
                counts.set(project, listQueuedAgents(project).length);
              }
              return counts;
            },
            initiativeEngineEnabled: async () => {
              const { getSettings } = await import('@/lib/shared/config');
              return getSettings().initiative_engine_enabled === true;
            },
            mineInitiatives: async () => {
              const { getSettings } = await import('@/lib/shared/config');
              const s = getSettings();
              if (!s.initiative_mining_enabled) return;
              const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
              const { resolveProjectPath } = await import('@/lib/shared/project-data');
              const { runProbes } = await import('@/lib/orchestrator/initiative-probes');
              const { admitProject } = await import('@/lib/orchestrator/initiative-admit');
              const { shouldMineProject, markProjectMined, getLastMineMap } =
                await import('@/lib/orchestrator/mining-throttle');
              const lastMine = getLastMineMap();
              const intervalMs = Math.max(0, s.initiative_mining_interval_minutes) * 60_000;
              const now = Date.now();
              const projects = listEnabledProjects();
              for (const p of projects) {
                // Throttle: don't re-mine a project more often than the configured
                // interval — mining runs lint/git per project and would otherwise
                // hammer the host every 60s tick.
                if (!shouldMineProject(p.name, now, lastMine, intervalMs)) continue;
                try {
                  const projectPath = resolveProjectPath(p.name);
                  if (!projectPath) continue;
                  const results = await runProbes(p.name, projectPath);
                  await admitProject(p.name, results, getSettings().initiative_max_backlog_per_project);
                  markProjectMined(p.name, now, lastMine);
                } catch (err) {
                  console.warn(`[initiative-engine] mineInitiatives: project ${p.name} failed:`, err);
                }
              }
            },
            dispatchInitiatives: async () => {
              const { getSettings } = await import('@/lib/shared/config');
              // Mine-only mode: discover + fill the backlog, but do not dispatch
              // or auto-merge. The loop still runs; this gate just holds the
              // release leg.
              if (!getSettings().initiative_dispatch_enabled) return;
              const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
              const store = await import('@/lib/orchestrator/initiatives-store');
              const { runGates } = await import('@/lib/shared/job-control');
              const { hasAgentStartSlot } = await import('@/lib/agents/pending-agent-run');
              const { isLockOwnedByActiveRelease } = await import('@/lib/pipeline/pipeline-lock');
              const { getPendingRelease } = await import('@/lib/pipeline/pending-release');
              const { reconcileRunningInitiatives } = await import('@/lib/orchestrator/initiative-reconcile');
              const { dispatchTopInitiative } = await import('@/lib/orchestrator/initiative-dispatch');
              const { markInitiativeOutcome, shipsTodayCount } = await import('@/lib/orchestrator/initiative-outcome');
              const { startInitiativeRun } = await import('@/lib/orchestrator/run-initiative');
              const { getJob, listJobs } = await import('@/lib/jobs/storage');
              const { probeJobStatus } = await import('@/lib/jobs/probe');
              const { isAgentJobKind } = await import('@/lib/jobs/kinds');
              const projects = listEnabledProjects();
              for (const p of projects) {
                try {
                  await reconcileRunningInitiatives(p.name, {
                    listRunning: (proj) => store.listByStatus(proj, 'running'),
                    jobStatus: async (jobId) => {
                      const job = getJob(jobId);
                      if (!job) return 'unknown';
                      if (job.finishedAt !== null) {
                        return (job.exitCode === 0) ? 'success' : 'failed';
                      }
                      const probed = await probeJobStatus(job);
                      return probed === 'done'
                        ? (job.exitCode === 0 ? 'success' : 'failed')
                        : 'running';
                    },
                    jobKind: (jobId) => {
                      const job = getJob(jobId);
                      if (!job) return 'unknown';
                      if (job.kind === 'release') return 'release';
                      if (isAgentJobKind(job.kind)) return 'agent';
                      return 'other';
                    },
                    markOutcome: (id, outcome, jobId) =>
                      markInitiativeOutcome(id, outcome, jobId),
                    now: () => Date.now(),
                    staleMs: 2 * 60 * 60 * 1000,
                  });
                  const ships = await shipsTodayCount(p.name);
                  await dispatchTopInitiative(p.name, {
                    listQueued: store.listQueued,
                    setStatus: store.setStatus,
                    gatesClear: () => runGates() === null,
                    projectBusy: async (proj) => {
                      if (hasAgentStartSlot(proj)) return true;
                      if (await isLockOwnedByActiveRelease(proj)) return true;
                      if (await getPendingRelease(proj)) return true;
                      return listJobs().some((job) => job.project === proj && job.finishedAt === null);
                    },
                    // Opt-in CI-red gate (default off): defer initiative dispatch
                    // while the project's default-branch CI is red. Same helper the
                    // scheduled-agent cron uses; fails open and un-blocks on green.
                    ciRed: async (proj) => {
                      const { resolveProjectPath: resolvePath } = await import('@/lib/shared/project-data');
                      const projPath = resolvePath(proj);
                      if (!projPath) return false;
                      const { isDefaultBranchCiRed } = await import('@/lib/jobs/ci-dispatch-gate');
                      return (await isDefaultBranchCiRed(projPath)).red;
                    },
                    shipsToday: () => ships,
                    maxShipsPerDay: getSettings().initiative_max_ships_per_day,
                    runInitiative: async (row) => {
                      const result = await startInitiativeRun(p.name, row);
                      if (result.status === 'started') {
                        // Temporary association: this is the agent job id.
                        // release-after-run replaces it with the release meta
                        // job id once the pipeline actually starts.
                        await store.setStatus(row.id, 'running', { releaseId: result.jobId });
                      }
                      return result;
                    },
                  });
                } catch (err) {
                  console.warn(`[initiative-engine] dispatchInitiatives: project ${p.name} failed:`, err);
                }
              }
            },
          },
          usageSnapshotDeps: {
            loadBridge: async () => {
              const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
              const res = await fetch(`${baseUrl}/api/stats/bridge`);
              if (!res.ok) throw new Error(`stats/bridge HTTP ${res.status}`);
              return res.json();
            },
            upsertSnapshots: async (rows) => {
              const { db, schema } = await import('@/lib/db');
              const { sql: drizzleSql } = await import('drizzle-orm');
              if (rows.length === 0) return;
              const recordedAt = Date.now() / 1000;
              await db
                .insert(schema.usageHourlySnapshot)
                .values(rows.map((r) => ({ ...r, recordedAt })))
                .onConflictDoUpdate({
                  target: [
                    schema.usageHourlySnapshot.bucketTs,
                    schema.usageHourlySnapshot.provider,
                    schema.usageHourlySnapshot.windowKey,
                  ],
                  set: {
                    utilizationPct: drizzleSql`excluded.utilization_pct`,
                    elapsedPct: drizzleSql`excluded.elapsed_pct`,
                    projectedPct: drizzleSql`excluded.projected_pct`,
                    paceMarginPct: drizzleSql`excluded.pace_margin_pct`,
                    status: drizzleSql`excluded.status`,
                    inputTokens: drizzleSql`excluded.input_tokens`,
                    outputTokens: drizzleSql`excluded.output_tokens`,
                    cacheReadTokens: drizzleSql`excluded.cache_read_tokens`,
                    cacheCreateTokens: drizzleSql`excluded.cache_create_tokens`,
                    jobCount: drizzleSql`excluded.job_count`,
                    recordedAt: drizzleSql`excluded.recorded_at`,
                  },
                });
            },
            loadTokenAggregates: async (bucketStartMs, bucketEndMs) => {
              const { db, schema } = await import('@/lib/db');
              const { and, gte, lt, isNotNull, sql: drizzleSql } = await import('drizzle-orm');
              const rows = await db
                .select({
                  provider: schema.jobs.provider,
                  inputTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.inputTokens}), 0)::bigint`,
                  outputTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.outputTokens}), 0)::bigint`,
                  cacheReadTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.cacheReadTokens}), 0)::bigint`,
                  cacheCreateTokens: drizzleSql<number>`COALESCE(SUM(${schema.jobs.cacheCreateTokens}), 0)::bigint`,
                  jobCount: drizzleSql<number>`COUNT(*)::int`,
                })
                .from(schema.jobs)
                .where(and(
                  isNotNull(schema.jobs.provider),
                  isNotNull(schema.jobs.finishedAt),
                  gte(schema.jobs.finishedAt, bucketStartMs / 1000),
                  lt(schema.jobs.finishedAt, bucketEndMs / 1000),
                ))
                .groupBy(schema.jobs.provider);
              const map = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; jobCount: number }>();
              for (const r of rows) {
                if (!r.provider) continue;
                map.set(r.provider, {
                  inputTokens: Number(r.inputTokens) || 0,
                  outputTokens: Number(r.outputTokens) || 0,
                  cacheReadTokens: Number(r.cacheReadTokens) || 0,
                  cacheCreateTokens: Number(r.cacheCreateTokens) || 0,
                  jobCount: Number(r.jobCount) || 0,
                });
              }
              return map;
            },
            enqueueNextFire: async (runAt) => {
              const { USAGE_SNAPSHOT_JOB_KEY } = await import('@/lib/workflows/cron/usage-snapshot-task');
              await quickAddJob(
                { connectionString },
                'usage-snapshot',
                {},
                { jobKey: USAGE_SNAPSHOT_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
          dbBackupDeps: {
            createBackup: async () => {
              const {
                createDatabaseBackup,
                getBackupDirectory,
                createBackupFilename,
              } = await import('@/lib/db/backup');
              const { join } = await import('path');
              const dir = getBackupDirectory();
              const dest = join(/*turbopackIgnore: true*/ dir, createBackupFilename());
              await createDatabaseBackup(dest);
              return dest;
            },
            pruneOld: async (justCreatedPath: string) => {
              const { pruneBackupFiles, getBackupDirectory } = await import('@/lib/db/backup');
              const { getSettings } = await import('@/lib/shared/config');
              const { basename } = await import('path');
              const s = getSettings();
              // Protect the dump we *just* created from this same prune
              // sweep. Otherwise `keepRecent=0` + `keepWeekly=0` would
              // delete the new file immediately, violating the retention
              // contract (the manual `/api/settings/backup` route already
              // does this).
              return pruneBackupFiles(getBackupDirectory(), {
                keepRecent: s.backup_retention_count,
                keepWeekly: s.backup_retention_weekly_count,
                protectedNames: [basename(justCreatedPath)],
              });
            },
            readConfig: async () => {
              // Refresh so toggling the interval/enabled in the UI is
              // honored on the very next fire without a server restart.
              const { getSettings, initSettings } = await import('@/lib/shared/config');
              await initSettings();
              const s = getSettings();
              return {
                enabled: !!s.db_backup_enabled,
                intervalMs: Math.max(1, s.db_backup_interval_minutes) * 60 * 1000,
              };
            },
            enqueueNextFire: async (runAt) => {
              const { DB_BACKUP_JOB_KEY } = await import('@/lib/workflows/cron/db-backup-task');
              await quickAddJob(
                { connectionString },
                'db-backup',
                {},
                { jobKey: DB_BACKUP_JOB_KEY, jobKeyMode: 'preserve_run_at', runAt, maxAttempts: 5 },
              );
            },
          },
        });

        // Seed the initial db-backup job so the chain starts after boot
        // even on a fresh install. Idempotent (jobKey replaces any
        // already-queued one).
        try {
          await quickAddJob(
            { connectionString },
            'db-backup',
            {},
            {
              jobKey: 'db-backup',
              jobKeyMode: 'preserve_run_at',
              runAt: new Date(Date.now() + 15 * 60 * 1000),
              maxAttempts: 5,
            },
          );
        } catch (err) {
          console.warn('[db-backup] seed failed:', err);
        }

        try {
          const { seedProjectSweep } = await import('@/lib/workflows/cron/seed-project-sweep');
          await seedProjectSweep({ connectionString });
        } catch (err) {
          console.warn('[cron] seedProjectSweep failed:', err);
        }

        try {
          const { seedOrchestratorTick } = await import('@/lib/workflows/cron/seed-orchestrator-tick');
          await seedOrchestratorTick({ connectionString });
        } catch (err) {
          console.warn('[cron] seedOrchestratorTick failed:', err);
        }

        try {
          const { seedUsageSnapshot } = await import('@/lib/workflows/cron/seed-usage-snapshot');
          await seedUsageSnapshot({ connectionString });
        } catch (err) {
          console.warn('[cron] seedUsageSnapshot failed:', err);
        }

        console.log('[cron] graphile-worker cron pool started (agent-cron + system-cron + project-sweep + orchestrator-tick + usage-snapshot)');
      } catch (err) {
        console.error('[cron] boot failed:', err);
      }
    })();
  }

  const probeIntervalMs = parseInt(process.env.TAMTAM_PROBE_INTERVAL_MS ?? '', 10) || 30_000;
  if (!(process.env.VITEST || (process.env.NODE_ENV as string) === 'test')) {
    setInterval(runProbeSweep, probeIntervalMs);
  }

  // Note: the hook-failure recovery loops that used to live here
  // (drainStaleQueuedAgentRuns scheduler, reconcileRecovery sweep,
  // autoResumeStuck, quota drain ticker) were removed when the workflow
  // runtime became the only release path. The workflow runtime handles
  // those concerns via its own durability. The on-demand resume route at
  // /api/projects/by-project/<name>/release/<id>/resume remains available
  // for manual operator intervention.
}
