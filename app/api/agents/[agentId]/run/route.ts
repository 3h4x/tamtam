import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { isLockOwnedByActiveRelease, getLock } from '@/lib/pipeline/pipeline-lock';
import { getPendingRelease, drainPendingRelease } from '@/lib/pipeline/pending-release';
import { enqueueQueuedAgentRun } from '@/lib/agents/queued-agent-runs';
import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { createJob, updateJob, listJobs, probeJobStatus, markDone } from '@/lib/jobs/job-storage';
import { registerJobCancellation, finishJobCancellation } from '@/lib/jobs/cancellation';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { exec } from '@/lib/shared/shell';
import { getDirtyFileCount } from '@/lib/git/dirty-worktree';
import { parseFileAgentId, loadFileAgent } from '@/lib/agents/tamtam-file-agents';
import { isProjectPaused } from '@/lib/shared/enabled-projects';
import { getAgentMemoryDir, getAgentMemoryPath, readAgentMemory, ensureAgentMemoryDir, buildMemoryBlock } from '@/lib/agents/agent-memory';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { enqueueAgentRun, tryClaimAgentStartSlot, releaseAgentStartSlot, drainNextAgentRun } from '@/lib/agents/pending-agent-run';
import { getSettings } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { sqlite } from '@/lib/db';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { retrieveAgentContext } from '@/lib/agents/retrieval/retriever';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { resolveAgentPrerequisiteCommand } from '@/lib/agents/issue-cruncher';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { isSqliteVecAvailable } from '@/lib/db/sqlite-vec';

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

  // Resolve agent — either a DB row or a file-based agent
  let agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean; provider?: string | null; prerequisiteCommand?: string | null } | null = null;

  const parsedFileId = parseFileAgentId(agentId);
  if (parsedFileId) {
    const projPath = resolveProjectPath(parsedFileId.project);
    if (!projPath) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });
    const fa = loadFileAgent(projPath, parsedFileId.project, parsedFileId.name);
    if (!fa) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });
    agent = { ...fa, skillIds: JSON.stringify(fa.skillIds), docPaths: JSON.stringify(fa.docPaths) };
  } else {
    const row = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (row) agent = row;
  }

  if (!agent) return NextResponse.json({ detail: 'agent not found' }, { status: 404 });

  // Reject scheduled triggers for disabled agents. PM2 may still hold stale
  // cron entries (e.g. after a rename or schedule clear) — this is the final
  // guard so disabled/unscheduled agents don't silently keep running.
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
  const agentSkillIds: string[] = JSON.parse(agent.skillIds || '[]');
  const hasSkills = agentSkillIds.length > 0;
  if (!taskPrompt && !hasSkills) {
    return NextResponse.json({ detail: 'agent has no prompt and no skills to run' }, { status: 400 });
  }

  // Block agent runs while a release pipeline holds the project lock.
  // Queue in DB (not in-memory) so the pending run survives a server restart.
  // The lock is released when the pipeline finishes, which drains this queue.
  if (isLockOwnedByActiveRelease(agent.project)) {
    const lock = getLock(agent.project);
    try {
      enqueueQueuedAgentRun(agent.project, {
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
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
  if (!readOnly) {
    const slot = tryClaimAgentStartSlot(agent.project, agent.name);
    if (!slot.ok) {
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
    if (!readOnly && getPendingRelease(agent.project)) {
      await drainPendingRelease(agent.project);
      const lock = getLock(agent.project);
      if (isLockOwnedByActiveRelease(agent.project) || getPendingRelease(agent.project)) {
        try {
          enqueueQueuedAgentRun(agent.project, {
            project: agent.project,
            agentId: agent.id,
            agentName: agent.name,
            triggeredBy,
            prompt: taskPrompt,
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
    if (!readOnly && dirtyThreshold > 0) {
      const projPath = resolveProjectPath(agent.project);
      if (projPath) {
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
    }

    const result = await runAgentStart(agent, taskPrompt, triggeredBy, readOnly);
    return result.response;
  } finally {
    if (claimedStartSlot) {
      releaseAgentStartSlot(agent.project);
      // Always re-check the queue after releasing the synchronous start slot.
      // Fast-finishing agents can complete and trigger a lifecycle drain before
      // this route unwinds; that drain now no-ops while the slot is held, so the
      // post-release route drain is the handoff that guarantees queued work
      // keeps moving whether startup succeeded or failed.
      await drainNextAgentRun(agent.project);
    }
  }
}

const PREREQUISITE_TIMEOUT_MS = 10 * 60 * 1000;
const PREREQUISITE_OUTPUT_MAX = 64 * 1024;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[…truncated ${s.length - max} bytes]`;
}

async function runAgentStart(
  agent: { id: string; name: string; project: string; skillIds: string; docPaths: string; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean; provider?: string | null; prerequisiteCommand?: string | null },
  taskPrompt: string,
  triggeredBy: string,
  readOnly: boolean,
): Promise<{ response: NextResponse; startedJob: boolean }> {

  const projPath = resolveProjectPath(agent.project);
  if (!projPath) {
    return {
      response: NextResponse.json({ detail: `project '${agent.project}' not found` }, { status: 404 }),
      startedJob: false,
    };
  }

  // Compose skills + docs into the system prompt. Shared with the magic-wand
  // prompt-improvement endpoint via `composeAgentSkills`.
  const allSkillIds: string[] = JSON.parse(agent.skillIds);
  const docPathsParsed: string[] = JSON.parse(agent.docPaths || '[]');
  const composed = composeAgentSkills(projPath, allSkillIds, docPathsParsed);
  const docParts = composed.docParts;
  const parts = composed.parts;
  const metaSkills = composed.metaSkills;
  const metaDocs = composed.metaDocs;
  const allParts = [...docParts, ...parts];
  const reportContract = `## TamTam Run Report

At the end of your run, include a short final section exactly named "TamTam Run Report" with:
- Summary: one sentence describing what happened
- Files changed: comma-separated repo-relative paths, or "none"
- Actionable work: "yes" or "no"
- Schedule recommendation: optional; only suggest a less frequent schedule when this run found no actionable work`;
  const [headR, statusR] = await Promise.all([
    exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
  ]);

  const requestedModel = agent.model ? normalizeModelInput(agent.model, 'normal') : null;
  const { logDir } = getImproveConfig();
  const gate = await checkCliStartGate('start an agent run', {
    preferred: agent.provider ?? null,
    strictPreferred: !!agent.provider,
    requestedModel,
    respectJobsPaused: triggeredBy === 'schedule',
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
  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  const contextMeta = {
    skills: metaSkills,
    docs: metaDocs,
    agent: { id: agent.id, name: agent.name, schedule: agent.schedule, triggeredBy },
    baseline: {
      head: headR.exitCode === 0 ? headR.stdout.trim() : null,
      status: statusR.exitCode === 0 ? statusR.stdout : null,
      dirty: statusR.exitCode === 0 ? statusR.stdout.trim().length > 0 : null,
    },
  };

  // Create the job row BEFORE running the prerequisite so the run is visible
  // in the UI, the log file streams in real time, and the user can cancel
  // mid-prerequisite. Previously the prereq ran ad-hoc inside the route and
  // the agent appeared stuck in "starting" for the entire prereq duration
  // (e.g. `pnpm check` can take many minutes).
  const initialContextMeta = JSON.stringify(contextMeta);
  const job = createJob(agent.project, `agent:${agent.name}`, 0, '', taskPrompt, initialContextMeta, taskPrompt);
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const prereqCmd = resolveAgentPrerequisiteCommand({
    project: agent.project,
    skillIds: allSkillIds,
    prerequisiteCommand: agent.prerequisiteCommand,
  });

  let prerequisiteResult: { command: string; exitCode: number; durationMs: number; stdout: string; stderr: string } | null = null;

  if (prereqCmd) {
    const cancelSignal = registerJobCancellation(job.id);
    const startedAt = Date.now();
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath,
      `# prerequisite: ${prereqCmd}\n# cwd: ${projPath}\n# started: ${new Date().toISOString()}\n\n`);
    const result = await exec('bash', ['-c', prereqCmd], {
      cwd: projPath,
      timeout: PREREQUISITE_TIMEOUT_MS,
      killProcessGroup: true,
      signal: cancelSignal,
      abortProcessTree: true,
    });
    prerequisiteResult = {
      command: prereqCmd,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
    const prerequisiteCancelled =
      cancelSignal.aborted
      || job.finishedAt != null
      || job.abortedAt != null
      || job.exitCode === -2;
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath,
      `${result.stdout || ''}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}\n` +
      `# prerequisite finished — exit ${result.exitCode} in ${prerequisiteResult.durationMs}ms\n\n`);

    if (prerequisiteCancelled) {
      appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `# prerequisite cancelled by user\n`);
      if (job.finishedAt === null) {
        job.finishedAt = Date.now() / 1000;
        job.exitCode = 130;
        updateJob(job);
        await markDone(job, 130);
      }
      finishJobCancellation(job.id);
      return {
        response: NextResponse.json({ status: 'cancelled', job_id: job.id }, { status: 200 }),
        startedJob: false,
      };
    }
    finishJobCancellation(job.id);
  }

  // The prerequisite can run for minutes. Re-check project-wide blockers before
  // spawning the agent so a queued/manual replay never gets acknowledged as
  // "started" until the final start disposition is known.
  if (isLockOwnedByActiveRelease(agent.project)) {
    const lock = getLock(agent.project);
    try {
      enqueueQueuedAgentRun(agent.project, {
        project: agent.project,
        agentId: agent.id,
        agentName: agent.name,
        triggeredBy,
        prompt: taskPrompt,
        enqueuedAt: Date.now(),
      });
    } catch (err) {
      console.error('[agent-run] failed to persist post-prereq release-lock queue entry:', err);
      job.exitCode = 1;
      await markDone(job, 1);
      return {
        response: NextResponse.json(
          { detail: `Failed to queue agent '${agent.name}' while the release pipeline is running` },
          { status: 500 },
        ),
        startedJob: false,
      };
    }
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# queued behind release pipeline lock — will run when lock releases\n`);
    job.finishedAt = Date.now() / 1000;
    job.exitCode = 0;
    updateJob(job);
    await markDone(job, 0);
    return {
      response: NextResponse.json(
        {
          status: 'queued',
          code: 'pipeline_lock',
          detail: `Agent '${agent.name}' queued — release pipeline is running for ${agent.project} (job ${lock?.lockedByJobId ?? 'unknown'})`,
          blockingJobId: lock?.lockedByJobId,
          agent: agent.name,
        },
        { status: 202 },
      ),
      startedJob: false,
    };
  }

  if (!readOnly) {
    const postPrereqBlockingJob = await findBlockingRunningJob(
      agent.project,
      (j) => !isAgentJobKind(j.kind) && j.id !== job.id,
    );
    if (postPrereqBlockingJob) {
      appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# blocked by ${postPrereqBlockingJob.kind} job ${postPrereqBlockingJob.id}\n`);
      job.finishedAt = Date.now() / 1000;
      job.exitCode = 1;
      updateJob(job);
      await markDone(job, 1);
      return {
        response: NextResponse.json(
          {
            code: 'project_busy',
            detail: `Job '${postPrereqBlockingJob.kind}' is already running for ${agent.project} (job ${postPrereqBlockingJob.id})`,
            blockingJobId: postPrereqBlockingJob.id,
          },
          { status: 409 },
        ),
        startedJob: false,
      };
    }
  }

  let prerequisiteBlock = '';
  if (prerequisiteResult) {
    const artifactPath = join(logDir, `${job.id}.prereq.txt`);
    const redactedCommand = redactSecrets(prerequisiteResult.command);
    const artifactBody =
      `# TamTam prerequisite artifact\n` +
      `command: ${redactedCommand}\n` +
      `exit_code: ${prerequisiteResult.exitCode}\n` +
      `duration_ms: ${prerequisiteResult.durationMs}\n` +
      `cwd: ${projPath}\n` +
      `--- stdout ---\n${redactSecrets(prerequisiteResult.stdout)}\n--- stderr ---\n${redactSecrets(prerequisiteResult.stderr)}\n`;
    try {
      writeFileSync(/*turbopackIgnore: true*/ artifactPath, artifactBody);
    } catch (e) {
      console.error('[agent-run] failed to write prereq artifact:', errMsg(e));
    }
    const truncatedStdout = truncate(redactSecrets(prerequisiteResult.stdout), PREREQUISITE_OUTPUT_MAX);
    const truncatedStderr = truncate(redactSecrets(prerequisiteResult.stderr), PREREQUISITE_OUTPUT_MAX);
    prerequisiteBlock =
      `## Prerequisite Output\n` +
      `Command: \`${redactedCommand}\`\n` +
      `Exit code: ${prerequisiteResult.exitCode}\n` +
      `Duration: ${prerequisiteResult.durationMs} ms\n` +
      `Artifact: ${artifactPath}\n\n` +
      `--- stdout ---\n${truncatedStdout}\n\n` +
      `--- stderr ---\n${truncatedStderr}`;
    job.contextMeta = JSON.stringify({
      ...contextMeta,
      prerequisite: {
        command: redactedCommand,
        exitCode: prerequisiteResult.exitCode,
        durationMs: prerequisiteResult.durationMs,
        artifactPath,
      },
    });
  }

  const systemPrompt = [...allParts, prerequisiteBlock, reportContract].filter(Boolean).join('\n\n---\n\n');

  // Inject agent memory so it can track state across runs.
  const memDir = getAgentMemoryDir();
  ensureAgentMemoryDir(memDir, agent.project);
  const memoryPath = getAgentMemoryPath(memDir, agent.project, agent.name);
  const currentMemory = readAgentMemory(memDir, agent.project, agent.name);
  const memoryBlock = buildMemoryBlock(memoryPath, currentMemory);

  // Build command. We prepend the composed skills directly to the prompt
  // (stdin) rather than using --append-system-prompt, which requires a value
  // argument and would need escaping for multi-line content.
  const modelFlag = requestedModel ? `--model ${requestedModel}` : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}`;

  const corePrompt = systemPrompt && taskPrompt
    ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
    : (systemPrompt || taskPrompt);

  let retrievedContext: string | null = null;
  if (settings.retrieval_enabled && taskPrompt && isSqliteVecAvailable()) {
    retrievedContext = await retrieveAgentContext({
      backend: new SqliteVecBackend(sqlite),
      project: agent.project,
      taskPrompt,
      limit: settings.retrieval_context_limit,
      scoreThreshold: settings.retrieval_score_threshold,
      ollamaUrl: settings.retrieval_ollama_url,
      embeddingModel: settings.retrieval_embedding_model,
    });
  }

  const promptWithRetrieval = retrievedContext
    ? `${retrievedContext}\n\n---\n\n${corePrompt}`
    : corePrompt;
  const fullPrompt = withBasePrompt(`${promptWithRetrieval}\n\n---\n\n${memoryBlock}`, { projectPath: projPath, provider });

  try {
    const pid = await startJob(job.id, cmd, fullPrompt, projPath, { env: cliEnv });
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# failed to start agent: ${errMsg(e)}\n`);
    await markDone(job, -1);
    return {
      response: NextResponse.json({ detail: `Failed to start: ${errMsg(e)}` }, { status: 500 }),
      startedJob: false,
    };
  }

  updateJob(job);

  return {
    response: NextResponse.json({
      status: 'started',
      job_id: job.id,
      pid: job.pid,
      agent: agent.name,
    }),
    startedJob: true,
  };
}
