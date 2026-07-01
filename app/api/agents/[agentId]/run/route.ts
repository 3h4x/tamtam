import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { isLockOwnedByActiveRelease, getLock } from '@/lib/pipeline/pipeline-lock';
import { getPendingRelease } from '@/lib/pipeline/pending-release';
import { drainProjectRecoveryWork } from '@/lib/pipeline/recovery-drain';
import { enqueueQueuedAgentRun } from '@/lib/agents/queued-agent-runs';
import { createJob, updateJob, listJobs, probeJobStatus, markDone } from '@/lib/jobs/job-storage';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import { errMsg } from '@/lib/shared/types';
import { getDirtyFileCount } from '@/lib/git/dirty-worktree';
import { isProjectPaused } from '@/lib/shared/enabled-projects';
import { getSettings, withBasePrompt } from '@/lib/shared/config';
import { normalizeModelInput, parseOptionalKnownModelInput, type ModelTier } from '@/lib/agents/model-aliases';
import { enqueueAgentRun, tryClaimAgentStartSlot, releaseAgentStartSlot, drainNextAgentRun } from '@/lib/agents/pending-agent-run';
import {
  attachJobToDurableAgentRunSlot,
  releaseDurableAgentRunSlot,
  tryClaimDurableAgentRunSlot,
} from '@/lib/agents/durable-agent-run-slot';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { resolveAgentPrerequisiteCommandWithFileSkills } from '@/lib/agents/file-skill-prerequisites';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { runAgentIntakeWorkflow } from '@/lib/agents/intake-workflow';
import { checkDailySpendCap, type SpendCapExceeded } from '@/lib/pipeline/spend-guard';
import { notify } from '@/lib/shared/notifications';
import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { estimatePromptCost, promptEstimateResponseDetail } from '@/lib/jobs/prompt-size';

type RunnableAgent = {
  id: string;
  name: string;
  project: string;
  skillIds: string;
  docPaths: string;
  model: string;
  prompt: string;
  schedule: string | null;
  enabled: boolean;
  provider?: string | null;
  fallbackEnabled?: boolean;
  prerequisiteCommand?: string | null;
  kind?: string;
};

async function createBlockedAgentJob(agent: RunnableAgent, block: SpendCapExceeded): Promise<string | null> {
  try {
    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
    const job = createJob(agent.project, `agent:${agent.name}`, process.pid, '');
    const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
    job.logPath = logPath;
    job.contextMeta = JSON.stringify({
      releaseStopReason: block.detail,
      budgetExceeded: {
        kind: block.kind,
        capUsd: block.capUsd,
        actualUsd: block.actualUsd,
      },
    });
    appendRedactedFileSync(
      logPath,
      `# agent run blocked — ${new Date().toISOString()}\n# project: ${agent.project}\n# agent: ${agent.name}\n# reason: ${block.detail}\n`,
    );
    updateJob(job);
    await markDone(job, -3);
    return job.id;
  } catch (err) {
    console.warn(`[agent-run-route] failed to create blocked agent row for ${agent.project}/${agent.name}:`, err);
    return null;
  }
}

/**
 * `readOnly: true` is for agents whose declared task does not edit the local
 * checkout, such as the built-in cto issue planner. Only explicit read-only
 * runs skip per-project worktree serialization; mutable agent metadata such as
 * name or skill IDs must not change concurrency behavior.
 *
 * Read-only runs skip per-project worktree serialization (busy jobs, other
 * agents, start slot, pending-release recovery, dirty-worktree), but still
 * honor same-agent duplicate protection, release pipeline locks, and
 * CLI/budget gates. Manual agent runs are allowed on `fix/issue-*` branches;
 * only scheduled fires are skipped there by the internal scheduler.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  // Resolve agent from the DB (the single source of truth).
  let agent: RunnableAgent | null = null;
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (rows[0]) agent = rows[0];

  if (!agent) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });

  // Reject scheduled triggers for disabled agents. Graphile-worker may still
  // hold stale schedule rows (e.g. after a rename or schedule clear) — this is
  // the final guard so disabled/unscheduled agents don't silently keep running.
  const triggeredBy = request.headers.get('x-tamtam-trigger') || 'manual';
  const isScheduled = triggeredBy === 'schedule';
  if (!agent.enabled && isScheduled) {
    return NextResponse.json({ code: 'agent_disabled', detail: `Agent '${agent.name}' is disabled — ignoring scheduled trigger` }, { status: 409 });
  }
  if (!agent.schedule && isScheduled) {
    return NextResponse.json({ code: 'no_schedule', detail: `Agent '${agent.name}' has no schedule — ignoring scheduled trigger` }, { status: 409 });
  }

  // Per-project pause toggle: blocks every agent run for this project
  // (scheduled and manual API calls). Manual /project/[name]/terminal sessions
  // bypass this — they go through the streaming routes, not /api/agents.
  if (isProjectPaused(agent.project)) {
    return NextResponse.json(
      { code: 'project_paused', detail: `Project '${agent.project}' is paused — agent runs are blocked. Resume on the project page to continue.` },
      { status: 409 },
    );
  }

  const body = await request.json();
  const taskPrompt = body.prompt?.trim() ?? '';
  const readOnly = body.readOnly === true;
  // Optional caller-supplied model override. Orchestrator boost fires set
  // `model` after deciding to promote the tier for this run.
  const { model: bodyModelOverride, error: modelError } = parseOptionalKnownModelInput(body.model, 'normal');
  if (modelError) {
    return NextResponse.json({ detail: modelError }, { status: 400 });
  }
  if (agent.kind === 'system') {
    const result = await runSystemAgentStart(agent);
    return result.response;
  }
  const dailySpendCap = await checkDailySpendCap(agent.project);
  if (!dailySpendCap.ok) {
    const jobId = await createBlockedAgentJob(agent, dailySpendCap);
    await notify({
      event: 'budget_exceeded',
      project: dailySpendCap.project,
      agent: agent.name,
      job_id: jobId ?? `${agent.project}-agent-budget-exceeded`,
      status: 'failed',
      reason: 'daily_spend_cap',
      cost_usd: dailySpendCap.actualUsd,
      message: `${dailySpendCap.detail}. Cap ${dailySpendCap.capUsd.toFixed(4)}, actual ${dailySpendCap.actualUsd.toFixed(4)}.`,
      throttleKeySuffix: `daily:${agent.name}`,
      timestamp: Date.now(),
    });
    return NextResponse.json(
      { code: 'budget_exceeded', detail: dailySpendCap.detail, agent: agent.name },
      { status: 429 },
    );
  }
  const agentSkillIds: string[] = JSON.parse(agent.skillIds || '[]');
  const hasSkills = agentSkillIds.length > 0;
  if (!taskPrompt && !hasSkills) {
    return NextResponse.json({ detail: 'agent has no prompt and no skills to run' }, { status: 400 });
  }

  // Scheduled fires must not pile work onto an open PR. While the project
  // is off the default branch or a release-pipeline `pr-wait` is in
  // flight, refuse scheduled runs. Manual `triggeredBy` still goes
  // through — the user explicitly asked for it. The cron task
  // re-enqueues on its own schedule, so the queue keeps ticking; when
  // the PR merges and HEAD returns to default, the next fire dispatches.
  if (triggeredBy === 'schedule' && !readOnly) {
    const prWaitInFlight = listJobs().some(j =>
      j.project === agent.project && j.kind === 'pr-wait' && j.finishedAt === null);
    let branchReason: string | null = null;
    if (!prWaitInFlight) {
      try {
        const projPath = resolveProjectPath(agent.project);
        if (projPath) {
          const { decidePrContext } = await import('@/lib/pipeline/pr-context');
          const pr = await decidePrContext(projPath);
          if (pr.shouldOpenPr) branchReason = `on non-default branch '${pr.currentBranch}'`;
        }
      } catch (err) {
        console.warn(`[agent-run-route] branch state check failed for ${agent.project}:`, err);
      }
    }
    if (prWaitInFlight || branchReason) {
      const detail = prWaitInFlight
        ? `Scheduled agent '${agent.name}' skipped — pr-wait in flight for ${agent.project} (awaiting merge)`
        : `Scheduled agent '${agent.name}' skipped — ${branchReason} for ${agent.project}`;
      return NextResponse.json(
        { status: 'skipped', code: 'awaiting_pr_merge', detail, agent: agent.name },
        { status: 202 },
      );
    }
  }

  // Block agent runs while a release pipeline holds the project lock.
  // Queue in DB (not in-memory) so the pending run survives a server restart.
  // The lock is released when the pipeline finishes, which drains this queue.
  if (await isLockOwnedByActiveRelease(agent.project)) {
    const lock = await getLock(agent.project);
    try {
      enqueueQueuedAgentRun(agent.project, {
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        modelOverride: bodyModelOverride,
        enqueuedAt: Date.now(),
      });
    } catch (err) {
      console.error('[agent-run-route] failed to persist release-lock queue entry:', err);
      return NextResponse.json(
        { detail: `Failed to queue agent '${agent.name}' while the release pipeline is running` },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        status: 'queued',
        code: 'pipeline_lock',
        detail: `Agent '${agent.name}' queued — release pipeline is running for ${agent.project} (job ${lock?.lockedByJobId ?? 'unknown'})`,
        blockingJobId: lock?.lockedByJobId,
        agent: agent.name,
      },
      { status: 202 },
    );
  }

  if (!readOnly) {
    const blockingJob = await findBlockingRunningJob(
      agent.project,
      (job) => !isAgentJobKind(job.kind),
    );
    if (blockingJob) {
      return NextResponse.json(
        {
          code: 'project_busy',
          detail: `Job '${blockingJob.kind}' is already running for ${agent.project} (job ${blockingJob.id})`,
          blockingJobId: blockingJob.id,
        },
        { status: 409 },
      );
    }
  }

  // Only one agent runs at a time per project — concurrent agents racing on
  // the same git worktree clobber each other's commits and branch state.
  //   - Same agent already running → reject (true duplicate, scheduler retries
  //     on the next tick; queueing would just recurse).
  //   - Different agent running on this project → enqueue this fire and return
  //     202 queued. Drained when the running agent finishes.
  const kindKey = `agent:${agent.name}`;
  const runningAgents = listJobs().filter(
    (j) => j.project === agent.project && isAgentJobKind(j.kind) && j.finishedAt === null
  );
  for (const j of runningAgents) {
    if ((await probeJobStatus(j)) !== 'running') continue;
    if (getJobKind(j.kind) === kindKey) {
      return NextResponse.json(
        { code: 'already_running', detail: `Agent '${agent.name}' is already running (job ${j.id})` },
        { status: 409 }
      );
    }
    if (!readOnly) {
      enqueueAgentRun(agent.project, {
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        modelOverride: bodyModelOverride ?? undefined,
        enqueuedAt: Date.now(),
      });
      return NextResponse.json(
        {
          status: 'queued',
          detail: `Agent '${agent.name}' queued — '${j.kind}' is running for ${agent.project} (job ${j.id})`,
          blockingJobId: j.id,
          agent: agent.name,
        },
        { status: 202 }
      );
    }
  }

  // Closes the TOCTOU between the listJobs check above and createJob below.
  // Concurrent fires would otherwise both observe an empty running-agent
  // list, then both pass through the awaits (issue-branch check, git exec,
  // CLI gate) to createJob, producing two simultaneous agent runs for the
  // same project.
  let claimedStartSlot = false;
  let durableStartSlotToken: string | null = null;
  let startedJob = false;
  if (!readOnly) {
    let durableSlot: Awaited<ReturnType<typeof tryClaimDurableAgentRunSlot>>;
    try {
      durableSlot = await tryClaimDurableAgentRunSlot({
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
      });
    } catch (err) {
      console.error('[agent-run-route] failed to claim durable agent run slot:', err);
      return NextResponse.json(
        { detail: `Failed to reserve agent run slot for ${agent.project}` },
        { status: 500 },
      );
    }

    if (!durableSlot.ok) {
      if (durableSlot.runningAgent === agent.name) {
        return NextResponse.json(
          {
            code: 'already_running',
            detail: `Agent '${agent.name}' is already running for ${agent.project}${durableSlot.jobId ? ` (job ${durableSlot.jobId})` : ''}`,
            blockingJobId: durableSlot.jobId,
          },
          { status: 409 },
        );
      }
      enqueueAgentRun(agent.project, {
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        modelOverride: bodyModelOverride ?? undefined,
        enqueuedAt: Date.now(),
      });
      return NextResponse.json(
        {
          status: 'queued',
          detail: `Agent '${agent.name}' queued — '${durableSlot.runningAgent}' is running for ${agent.project}`,
          blockingJobId: durableSlot.jobId,
          agent: agent.name,
        },
        { status: 202 },
      );
    }
    durableStartSlotToken = durableSlot.token;

    const slot = tryClaimAgentStartSlot(agent.project, agent.name);
    if (!slot.ok) {
      await releaseDurableAgentRunSlot(agent.project, durableStartSlotToken);
      durableStartSlotToken = null;
      if (slot.runningAgent === agent.name) {
        return NextResponse.json(
          { code: 'already_starting', detail: `Agent '${agent.name}' is already starting for ${agent.project}` },
          { status: 409 }
        );
      }
      enqueueAgentRun(agent.project, {
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        modelOverride: bodyModelOverride ?? undefined,
        enqueuedAt: Date.now(),
      });
      return NextResponse.json(
        {
          status: 'queued',
          detail: `Agent '${agent.name}' queued — '${slot.runningAgent}' is starting for ${agent.project}`,
          agent: agent.name,
        },
        { status: 202 }
      );
    }
    claimedStartSlot = true;
  }

  try {
    // A previously-queued release must get first chance to reacquire the lock
    // before any newer agent work starts on the same project. Check only once
    // we know no other agent on the project is running or starting.
    if (!readOnly && await getPendingRelease(agent.project)) {
      await drainProjectRecoveryWork(agent.project, '[agent-run-route]');
      const lock = await getLock(agent.project);
      if (await isLockOwnedByActiveRelease(agent.project) || await getPendingRelease(agent.project)) {
        try {
          enqueueQueuedAgentRun(agent.project, {
            project: agent.project,
            agentId: agent.id,
            agentName: agent.name,
            triggeredBy,
            prompt: taskPrompt,
            modelOverride: bodyModelOverride,
            enqueuedAt: Date.now(),
          });
        } catch (err) {
          console.error('[agent-run-route] failed to persist pending-release queue entry:', err);
          return NextResponse.json(
            { detail: `Failed to queue agent '${agent.name}' while the pending release is recovering` },
            { status: 500 },
          );
        }
        return NextResponse.json(
          {
            status: 'queued',
            code: lock ? 'pipeline_lock' : 'pending_release',
            detail: lock
              ? `Agent '${agent.name}' queued — release pipeline is running for ${agent.project} (job ${lock.lockedByJobId})`
              : `Agent '${agent.name}' queued — pending release for ${agent.project} will run before new agent work`,
            blockingJobId: lock?.lockedByJobId,
            agent: agent.name,
          },
          { status: 202 },
        );
      }
    }

    // Don't start an agent on top of a large pile of uncommitted changes.
    // Agent edits would tangle with WIP and either get committed by mistake
    // (auto-commit pipelines) or trigger noisy review/fix loops over code the
    // user is mid-refactor. Threshold of 0 disables the gate.
    const settings = getSettings();
    const dirtyThreshold = settings.dirty_worktree_block_threshold;
    if (!readOnly) {
      const projPath = resolveProjectPath(agent.project);
      if (projPath) {
        if (dirtyThreshold > 0) {
          const dirtyCount = await getDirtyFileCount(projPath);
          if (dirtyCount >= dirtyThreshold) {
            return NextResponse.json(
              {
                code: 'dirty_worktree',
                detail: `Agent '${agent.name}' skipped — ${dirtyCount} uncommitted files exceed threshold (${dirtyThreshold}). Commit, stash, or discard changes first.`,
              },
              { status: 409 },
            );
          }
        }
        // Branch must be rebased on the latest `origin/<default>` before any
        // agent runs — otherwise the agent's commits land on a stale base and
        // produce conflicts at PR/merge time. The reconciler in
        // `lib/jobs/stranded-branch-reconcile.ts` handles dirty/behind state;
        // this gate just refuses to launch new agent work while it's stale.
        const { checkBranchFresh } = await import('@/lib/git/branch-freshness');
        const freshness = await checkBranchFresh(projPath);
        if (!freshness.fresh) {
          return NextResponse.json(
            {
              code: 'branch_stale',
              detail: `Agent '${agent.name}' skipped — ${freshness.reason}`,
            },
            { status: 409 },
          );
        }
      }
    }

    const result = await runAgentStart(agent, taskPrompt, triggeredBy, readOnly, bodyModelOverride, durableStartSlotToken);
    startedJob = result.startedJob;
    return result.response;
  } finally {
    if (claimedStartSlot) {
      releaseAgentStartSlot(agent.project);
    }
    if (durableStartSlotToken && !startedJob) {
      try {
        await releaseDurableAgentRunSlot(agent.project, durableStartSlotToken);
      } catch (err) {
        console.error('[agent-run-route] failed to release durable agent run slot:', err);
      }
    }
    if (claimedStartSlot) {
      // Always re-check the queue after releasing the synchronous start slot.
      // Fast-finishing agents can complete and trigger a lifecycle drain before
      // this route unwinds; that drain now no-ops while the slot is held, so the
      // post-release route drain is the handoff that guarantees queued work
      // keeps moving whether startup succeeded or failed.
      try {
        await drainNextAgentRun(agent.project);
      } catch (err) {
        console.error('[agent-run-route] post-start queue drain failed:', err);
      }
    }
  }
}

async function runSystemAgentStart(
  agent: { id: string; name: string; project: string; schedule: string | null; prompt: string | null; enabled: boolean },
): Promise<{ response: NextResponse; startedJob: boolean }> {
  const kindKey = `agent:${agent.name}`;
  for (const job of listJobs()) {
    if (job.project !== agent.project || getJobKind(job.kind) !== kindKey || job.finishedAt !== null) continue;
    if ((await probeJobStatus(job)) !== 'running') continue;
    return {
      response: NextResponse.json(
        { code: 'already_running', detail: `Agent '${agent.name}' is already running (job ${job.id})` },
        { status: 409 },
      ),
      startedJob: false,
    };
  }

  const { getSystemAgentHandler } = await import('@/lib/agents/system');
  const handler = getSystemAgentHandler(agent.name);
  if (!handler) {
    return {
      response: NextResponse.json(
        { code: 'system_agent_handler_missing', detail: `System agent '${agent.name}' has no registered handler` },
        { status: 409 },
      ),
      startedJob: false,
    };
  }
  const result = await handler.run({
    id: agent.id,
    project: agent.project,
    name: agent.name,
    schedule: agent.schedule,
    prompt: agent.prompt ?? '',
    enabled: agent.enabled,
    kind: 'system',
    boostable: true,
    model: 'normal',
    role: 'producer',
    autopilot: {},
  });
  return {
    response: NextResponse.json({
      status: 'started',
      job_id: result.jobId,
      pid: 0,
      agent: agent.name,
      via: 'system',
    }),
    startedJob: true,
  };
}

async function runAgentStart(
  agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; enabled: boolean; provider?: string | null; fallbackEnabled?: boolean; prerequisiteCommand?: string | null; permissionMode?: string | null },
  taskPrompt: string,
  triggeredBy: string,
  readOnly: boolean,
  modelOverride: ModelTier | null = null,
  durableStartSlotToken: string | null = null,
): Promise<{ response: NextResponse; startedJob: boolean; jobId?: string }> {

  const projPath = resolveProjectPath(agent.project);
  if (!projPath) {
    return {
      response: NextResponse.json({ detail: `project '${agent.project}' not found` }, { status: 404 }),
      startedJob: false,
    };
  }

  // Workflow owns prompt composition. We only need the parsed skill/doc IDs
  // to hand off, plus the admission gate decision so this route still rejects
  // synchronously when the CLI is over budget / paused.
  const allSkillIds: string[] = JSON.parse(agent.skillIds);
  const docPathsParsed: string[] = JSON.parse(agent.docPaths || '[]');

  // Caller's modelOverride (orchestrator boost) wins over the agent's stored
  // model. The CLI gate, intake workflow, and job record all see this as if
  // it were the agent's configured model for this run.
  const effectiveModel = modelOverride ?? (agent.model || null);
  const requestedModel = effectiveModel ? normalizeModelInput(effectiveModel, 'normal') : null;
  const { logDir } = getImproveConfig();
  const gate = await checkCliStartGate('start an agent run', {
    preferred: agent.provider ?? null,
    strictPreferred: !!agent.provider,
    requestedModel,
    respectJobsPaused: triggeredBy === 'schedule',
    isScheduled: triggeredBy === 'schedule',
  });
  if (!gate.ok) {
    const gateCode =
      gate.status === 409 && gate.detail.includes('Jobs are paused globally') ? 'jobs_paused' :
      gate.status === 429 ? 'providers_over_budget' :
      undefined;
    return {
      response: NextResponse.json(
        gateCode ? { code: gateCode, detail: gate.detail } : { detail: gate.detail },
        { status: gate.status },
      ),
      startedJob: false,
    };
  }
  const provider = gate.provider;

  const estimatedAgentContext = await composeAgentSkills(projPath, allSkillIds, docPathsParsed);
  const promptEstimatePayload = withBasePrompt(
    [
      ...estimatedAgentContext.docParts,
      ...estimatedAgentContext.parts,
      taskPrompt,
    ].filter(Boolean).join('\n\n---\n\n'),
    { projectPath: projPath, provider },
  );
  const promptEstimate = estimatePromptCost(promptEstimatePayload, { modelTier: effectiveModel });
  if (promptEstimate.blocked) {
    return {
      response: NextResponse.json({
        code: 'prompt_estimate_blocked',
        detail: promptEstimateResponseDetail(promptEstimate),
        prompt_estimate: promptEstimate,
      }, { status: 413 }),
      startedJob: false,
    };
  }

  // Resolve prereqCmd early so initialContextMeta can advertise the prerequisite
  // before the workflow starts. This lets the terminal page bootstrap in passthrough
  // streaming mode immediately (hasPrerequisiteContext=true), so raw shell output
  // from the prereq is rendered instead of silently dropped as non-NDJSON.
  const prereqCmd = resolveAgentPrerequisiteCommandWithFileSkills({
    project: agent.project,
    skillIds: allSkillIds,
    prerequisiteCommand: agent.prerequisiteCommand,
  });

  // Create the job row BEFORE handing off to the workflow so the run is
  // visible in the UI immediately. The workflow's compose step fills in
  // contextMeta (skills/docs/baseline/etc); seed an empty object so it has
  // a parseable starting point. Include a pending prerequisite marker when
  // the agent has a prereq command so the terminal bootstrap can start the
  // stream in passthrough mode immediately — otherwise the terminal loads the
  // job, sees no prerequisite, starts in non-passthrough mode, and raw prereq
  // output is silently dropped as unparseable NDJSON.
  const initialContextMeta = JSON.stringify({
    agent: {
      id: agent.id,
      name: agent.name,
      schedule: agent.schedule,
      triggeredBy,
      // Carry role so the finalizer can interpret value per role (only
      // producers get diff-based unfruitful/backoff recommendations).
      role: (agent as { role?: string }).role ?? 'producer',
    },
    ...(prereqCmd ? { prerequisite: { pending: true } } : {}),
  });
  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt, initialContextMeta, taskPrompt);
  job.provider = provider;
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  if (durableStartSlotToken) {
    const attached = await attachJobToDurableAgentRunSlot(agent.project, durableStartSlotToken, job.id);
    if (!attached) {
      job.finishedAt = Date.now() / 1000;
      job.exitCode = -1;
      updateJob(job);
      await markDone(job, -1);
      return {
        response: NextResponse.json(
          { detail: `Agent '${agent.name}' lost its run slot before workflow start` },
          { status: 409 },
        ),
        startedJob: false,
      };
    }
  }

  // Durable workflow path is the only agent intake path. The workflow owns
  // prompt composition, optional prereq execution, retrieval, memory, and
  // in-process spawn; everything after spawn (lifecycle, streaming, completion
  // hooks) remains unchanged.
  try {
    const { start } = await import('workflow/api');
    const run = await start(runAgentIntakeWorkflow, [{
      jobId: job.id,
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project,
      projPath,
      skillIds: allSkillIds,
      docPaths: docPathsParsed,
      model: effectiveModel,
      taskPrompt,
      triggeredBy,
      provider,
      fallbackEnabled: agent.fallbackEnabled === true,
      logPath,
      logDir,
      baseContextMeta: initialContextMeta,
      prereqCmd: prereqCmd ?? null,
      readOnly,
      permissionMode: agent.permissionMode ?? null,
    }]);
    // Record the workflow run id in context_meta so the jobs DELETE route
    // can propagate user-initiated aborts to the runtime via
    // `getRun(runId).cancel()` — without this, the workflow_runs row
    // stays "completed" even when the CLI child was killed.
    try {
      const meta = JSON.parse(job.contextMeta || initialContextMeta || '{}');
      meta.workflowRunId = run.runId;
      job.contextMeta = JSON.stringify(meta);
      updateJob(job);
    } catch (e) {
      console.warn('[agents/run] failed to persist workflowRunId on job:', errMsg(e));
    }
  } catch (e: unknown) {
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# workflow: failed to enqueue: ${errMsg(e)}\n`);
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    await markDone(job, -1);
    return {
      response: NextResponse.json({ detail: `Workflow failed to enqueue: ${errMsg(e)}` }, { status: 500 }),
      startedJob: false,
    };
  }
  return {
    response: NextResponse.json({
      status: 'started',
      job_id: job.id,
      pid: 0,
      agent: agent.name,
      via: 'workflow',
      prompt_estimate: promptEstimate,
    }),
    startedJob: true,
    jobId: job.id,
  };
}
