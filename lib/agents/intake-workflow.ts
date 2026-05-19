import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { withBasePrompt, getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import {
  buildMemoryBlock,
  readAgentMemory,
  getAgentMemoryDir,
  getAgentMemoryPath,
  ensureAgentMemoryDir,
} from '@/lib/agents/agent-memory';
import { exec } from '@/lib/shared/shell';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';
import { hasIssueCruncherSkill } from '@/lib/agents/issue-cruncher';
import { updateJob } from '@/lib/jobs/job-storage';
import { startInProcessAgentJob } from '@/lib/jobs/inline-agent';
import { errMsg } from '@/lib/shared/types';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import { resolveAutoAttachedDocs, formatAutoAttachedDocsBlock } from '@/lib/skills/auto-attach-docs';
import { writeFileSync } from 'fs';
import { join } from 'path';

const PREREQUISITE_TIMEOUT_MS = 10 * 60 * 1000;
const PREREQUISITE_OUTPUT_MAX = 64 * 1024;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[…truncated ${s.length - max} bytes]`;
}

export interface AgentIntakeParams {
  jobId: string;
  agentId: string;
  agentName: string;
  project: string;
  projPath: string;
  skillIds: string[];
  docPaths: string[];
  model: string | null;
  taskPrompt: string;
  triggeredBy: string;
  provider: string;
  fallbackEnabled: boolean;
  logPath: string;
  logDir: string;
  baseContextMeta: string;
  prereqCmd: string | null;
  readOnly: boolean;
}

interface PrereqResult {
  cancelled: boolean;
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface ComposeResult {
  skipped: boolean;
  fullPrompt: string;
  cmd: string;
  cliEnv: Record<string, string>;
  provider: CliProvider;
  fallback: {
    provider: CliProvider;
    cmd: string;
    cliEnv: Record<string, string>;
  } | null;
  contextMeta: string;
  prereqArtifact: { path: string; body: string } | null;
}

export async function runAgentIntakeWorkflow(params: AgentIntakeParams): Promise<void> {
  'use workflow';

  const prereqResult = params.prereqCmd ? await runPrerequisiteStep(params) : null;
  if (prereqResult?.cancelled) return;

  const composed = await composePromptStep(params, prereqResult);
  if (composed.skipped) return;

  await startAgentStep(params.jobId, params.projPath, composed);
}

async function runPrerequisiteStep(params: AgentIntakeParams): Promise<PrereqResult> {
  'use step';

  const { jobId, projPath, logPath, prereqCmd } = params;

  const { getJob } = await import('@/lib/jobs/job-storage');
  const job = getJob(jobId);
  if (!job || job.finishedAt != null) {
    return { cancelled: true, command: prereqCmd!, exitCode: -1, durationMs: 0, stdout: '', stderr: '' };
  }

  const { registerJobCancellation, finishJobCancellation } = await import('@/lib/jobs/cancellation');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');

  const cancelSignal = registerJobCancellation(jobId);
  const startedAt = Date.now();

  appendRedactedFileSync(
    /*turbopackIgnore: true*/ logPath,
    `# prerequisite: ${prereqCmd}\n# cwd: ${projPath}\n# started: ${new Date().toISOString()}\n\n`,
  );

  // exec wraps child_process.execFile safely — no shell injection risk here since
  // prereqCmd is operator-configured, not user-supplied, and runs through the
  // same path as the direct route handler.
  const result = await exec('bash', ['-c', prereqCmd!], {
    cwd: projPath,
    timeout: PREREQUISITE_TIMEOUT_MS,
    killProcessGroup: true,
    signal: cancelSignal,
    abortProcessTree: true,
  });

  const durationMs = Date.now() - startedAt;
  const currentJob = getJob(jobId);
  const cancelled = cancelSignal.aborted || currentJob?.finishedAt != null || currentJob?.exitCode === -2;

  appendRedactedFileSync(
    /*turbopackIgnore: true*/ logPath,
    `${result.stdout || ''}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}\n` +
      `# prerequisite finished — exit ${result.exitCode} in ${durationMs}ms\n\n`,
  );

  finishJobCancellation(jobId);

  if (cancelled) {
    appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `# prerequisite cancelled by user\n`);
    const { markDone } = await import('@/lib/jobs/job-storage');
    const j = getJob(jobId);
    if (j && j.finishedAt === null) {
      j.finishedAt = Date.now() / 1000;
      j.exitCode = 130;
      updateJob(j);
      await markDone(j, 130);
    }
    return { cancelled: true, command: prereqCmd!, exitCode: 130, durationMs, stdout: '', stderr: '' };
  }

  return {
    cancelled: false,
    command: prereqCmd!,
    exitCode: result.exitCode,
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function composePromptStep(
  params: AgentIntakeParams,
  prereqResult: PrereqResult | null,
): Promise<ComposeResult> {
  'use step';

  const {
    jobId,
    agentId,
    agentName,
    project,
    projPath,
    skillIds,
    docPaths,
    model,
    taskPrompt,
    triggeredBy,
    provider,
    fallbackEnabled,
    logPath,
    logDir,
    baseContextMeta,
    readOnly,
  } = params;

  // Post-prereq release-lock re-check (prereq can run for minutes).
  if (prereqResult) {
    const { isLockOwnedByActiveRelease, getLock } = await import('@/lib/pipeline/pipeline-lock');
    const { enqueueQueuedAgentRun } = await import('@/lib/agents/queued-agent-runs');
    const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
    const { getJob, markDone } = await import('@/lib/jobs/job-storage');

    if (await isLockOwnedByActiveRelease(project)) {
      await getLock(project);
      try {
        enqueueQueuedAgentRun(project, {
          project,
          agentId,
          agentName,
          triggeredBy,
          prompt: taskPrompt,
          enqueuedAt: Date.now(),
        });
      } catch (err) {
        console.error('[intake-workflow] failed to persist post-prereq release-lock queue entry:', err);
        const j = getJob(jobId);
        if (j) { j.exitCode = 1; await markDone(j, 1); }
        return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, prereqArtifact: null };
      }
      appendRedactedFileSync(
        /*turbopackIgnore: true*/ logPath,
        `\n# queued behind release pipeline lock — will run when lock releases\n`,
      );
      const j = getJob(jobId);
      if (j) { j.finishedAt = Date.now() / 1000; j.exitCode = 0; updateJob(j); await markDone(j, 0); }
      return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, prereqArtifact: null };
    }

    // Post-prereq worktree blocker for non-readOnly runs.
    if (!readOnly) {
      const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
      const { isAgentJobKind } = await import('@/lib/jobs/kinds');

      const blocking = await findBlockingRunningJob(project, (j) => !isAgentJobKind(j.kind) && j.id !== jobId);
      if (blocking) {
        appendRedactedFileSync(
          /*turbopackIgnore: true*/ logPath,
          `\n# blocked by ${blocking.kind} job ${blocking.id}\n`,
        );
        const j = getJob(jobId);
        if (j) { j.finishedAt = Date.now() / 1000; j.exitCode = 1; updateJob(j); await markDone(j, 1); }
        return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, prereqArtifact: null };
      }
    }
  }

  const composed = await composeAgentSkills(projPath, skillIds, docPaths);

  const [headR, statusR] = await Promise.all([
    exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
  ]);

  // Build prereq block and artifact info.
  let prereqBlock = '';
  let prereqArtifact: { path: string; body: string } | null = null;
  if (prereqResult) {
    const artifactPath = join(/*turbopackIgnore: true*/ logDir, `${jobId}.prereq.txt`);
    const redactedCommand = redactSecrets(prereqResult.command);
    const artifactBody =
      `# TamTam prerequisite artifact\n` +
      `command: ${redactedCommand}\n` +
      `exit_code: ${prereqResult.exitCode}\n` +
      `duration_ms: ${prereqResult.durationMs}\n` +
      `cwd: ${projPath}\n` +
      `--- stdout ---\n${redactSecrets(prereqResult.stdout)}\n--- stderr ---\n${redactSecrets(prereqResult.stderr)}\n`;
    prereqArtifact = { path: artifactPath, body: artifactBody };
    const truncatedStdout = truncate(redactSecrets(prereqResult.stdout), PREREQUISITE_OUTPUT_MAX);
    const truncatedStderr = truncate(redactSecrets(prereqResult.stderr), PREREQUISITE_OUTPUT_MAX);
    prereqBlock =
      `## Prerequisite Output\n` +
      `Command: \`${redactedCommand}\`\n` +
      `Exit code: ${prereqResult.exitCode}\n` +
      `Duration: ${prereqResult.durationMs} ms\n` +
      `Artifact: ${artifactPath}\n\n` +
      `--- stdout ---\n${truncatedStdout}\n\n` +
      `--- stderr ---\n${truncatedStderr}`;
  }

  const baseCtx = JSON.parse(baseContextMeta) as Record<string, unknown>;
  const contextMetaObj: Record<string, unknown> = {
    ...baseCtx,
    skills: composed.metaSkills,
    docs: composed.metaDocs,
    agent: { id: agentId, name: agentName, triggeredBy },
    baseline: {
      head: headR.exitCode === 0 ? headR.stdout.trim() : null,
      status: statusR.exitCode === 0 ? statusR.stdout : null,
      dirty: statusR.exitCode === 0 ? statusR.stdout.trim().length > 0 : null,
    },
    workflow: true,
  };

  if (prereqResult && prereqArtifact) {
    contextMetaObj.prerequisite = {
      command: redactSecrets(prereqResult.command),
      exitCode: prereqResult.exitCode,
      durationMs: prereqResult.durationMs,
      artifactPath: prereqArtifact.path,
    };
  }

  const reportContract = `## TamTam Run Report

At the end of your run, include a short final section exactly named "TamTam Run Report" with:
- Summary: one sentence describing what happened
- Files changed: comma-separated repo-relative paths, or "none"
- Actionable work: "yes" or "no"
- Schedule recommendation: optional; only suggest a less frequent schedule when this run found no actionable work`;

  // Auto-attach project docs based on keywords in the task prompt. Agents are
  // always single-shot (no --resume), so every run is a "first invocation".
  let autoAttachBlock: string | null = null;
  const autoAttachedDocPaths: string[] = [];
  if (taskPrompt) {
    const autoDocs = resolveAutoAttachedDocs(projPath, taskPrompt, loadFileConfig(projPath));
    autoAttachBlock = formatAutoAttachedDocsBlock(autoDocs);
    for (const d of autoDocs) autoAttachedDocPaths.push(d.rulePath);
  }
  if (autoAttachedDocPaths.length > 0) {
    contextMetaObj.autoAttachedDocs = autoAttachedDocPaths;
  }

  const allParts = [...composed.docParts, ...composed.parts];
  const systemPrompt = [...allParts, autoAttachBlock, prereqBlock, reportContract].filter(Boolean).join('\n\n---\n\n');
  const corePrompt =
    systemPrompt && taskPrompt
      ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
      : systemPrompt || taskPrompt;

  const memDir = getAgentMemoryDir();
  ensureAgentMemoryDir(memDir, project);
  const memoryPath = getAgentMemoryPath(memDir, project, agentName);
  const currentMemory = readAgentMemory(memDir, project, agentName);
  const memoryBlock = buildMemoryBlock(memoryPath, currentMemory);

  // Retrieval context (pgvector, if enabled).
  let retrievedContext: string | null = null;
  const settings = getSettings();
  if (settings.retrieval_enabled && taskPrompt) {
    try {
      const { PgvectorBackend } = await import('@/lib/agents/retrieval/pgvector-backend');
      const { retrieveAgentContextDetailed } = await import('@/lib/agents/retrieval/retriever');
      const retrieval = await retrieveAgentContextDetailed({
        backend: new PgvectorBackend(),
        project,
        taskPrompt,
        limit: settings.retrieval_context_limit,
        scoreThreshold: settings.retrieval_score_threshold,
        ollamaUrl: settings.retrieval_ollama_url,
        embeddingModel: settings.retrieval_embedding_model,
      });
      retrievedContext = retrieval.block;
      if ((retrieval.diagnostics.sources?.length ?? 0) > 0) {
        contextMetaObj.retrieval = retrieval.diagnostics;
      }
    } catch (e) {
      console.warn('[intake-workflow] retrieval failed, skipping:', errMsg(e));
    }
  }

  const promptWithRetrieval = retrievedContext
    ? `${retrievedContext}\n\n---\n\n${corePrompt}`
    : corePrompt;

  const requestedModel = model ? normalizeModelInput(model, 'normal') : null;
  const safeProvider = isCliProvider(provider) ? provider : 'claude';
  const claudeBin = resolveCliBin(safeProvider, settings);
  const cliEnv = resolveCliEnv(safeProvider, settings);
  const modelFlag = requestedModel ? `--model ${requestedModel}` : '';
  // Defense-in-depth for the issue-cruncher: the skill prompt forbids the
  // agent from running `gh issue …` (TamTam gathers all authorized issue
  // content server-side) and from running `git checkout` (TamTam auto-checks
  // out the issue branch as part of `pick_top=1`). Wire the same bans into
  // Claude's tool-permission layer so even a prompt-injected agent cannot
  // bypass them. Covers gh CLI + REST API + the git switch primitives that
  // would otherwise let the agent move work to a different branch.
  const issueCruncherDenyFlag = hasIssueCruncherSkill(skillIds)
    ? ` --disallowed-tools "Bash(gh issue:*),Bash(gh api repos/*/issues:*),Bash(gh api repos/*/issues/*:*),Bash(git checkout:*),Bash(git switch:*)"`
    : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}${issueCruncherDenyFlag}`;
  const fallbackProvider = await resolveFallbackProvider({
    enabled: fallbackEnabled,
    currentProvider: safeProvider,
    requestedModel,
    respectJobsPaused: triggeredBy === 'schedule',
    settings,
  });
  const fallback = fallbackProvider
    ? {
        provider: fallbackProvider,
        cmd: `${resolveCliBin(fallbackProvider, settings)} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}${issueCruncherDenyFlag}`,
        cliEnv: resolveCliEnv(fallbackProvider, settings),
      }
    : null;
  if (fallback) {
    contextMetaObj.providerFallback = {
      enabled: true,
      from: safeProvider,
      to: fallback.provider,
      maxRetries: 1,
    };
  }

  const fullPrompt = withBasePrompt(`${promptWithRetrieval}\n\n---\n\n${memoryBlock}`, {
    projectPath: projPath,
    provider: safeProvider,
  });

  return {
    skipped: false,
    fullPrompt,
    cmd,
    cliEnv,
    provider: safeProvider,
    fallback,
    contextMeta: JSON.stringify(contextMetaObj),
    prereqArtifact,
  };
}

async function resolveFallbackProvider({
  enabled,
  currentProvider,
  requestedModel,
  respectJobsPaused,
  settings,
}: {
  enabled: boolean;
  currentProvider: CliProvider;
  requestedModel: ReturnType<typeof normalizeModelInput> | null;
  respectJobsPaused: boolean;
  settings: ReturnType<typeof getSettings>;
}): Promise<CliProvider | null> {
  if (!enabled) return null;
  const chain = settings.provider_fallback_chain;
  const currentIndex = chain.indexOf(currentProvider);
  if (currentIndex < 0) return null;
  const nextProvider = chain[currentIndex + 1] ?? null;
  if (!nextProvider || nextProvider === currentProvider) return null;
  const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
  const gate = await checkCliStartGate('retry an agent run with a fallback provider', {
    preferred: nextProvider,
    strictPreferred: true,
    requestedModel,
    respectJobsPaused,
  });
  return gate.ok ? gate.provider : null;
}

async function startAgentStep(
  jobId: string,
  projPath: string,
  composed: ComposeResult,
): Promise<void> {
  'use step';

  const { fullPrompt, cmd, cliEnv, contextMeta, prereqArtifact, fallback } = composed;

  const { getJob, markDone } = await import('@/lib/jobs/job-storage');
  const job = getJob(jobId);
  if (!job) throw new Error(`[intake-workflow] job ${jobId} not found`);

  // Replay guard: a server restart mid-spawn lets the Workflow runtime
  // retry this step from the event log (attempt > 1). If the jobs row
  // has since been finalized — usually by `reapAbandonedInlineJobs` at
  // boot, which marks the orphaned PID's row exit=-1 — re-spawning the
  // CLI would just double-bill the agent and run against a stale row.
  // Skip cleanly before starting any per-run infrastructure so a replayed
  // finalized job cannot leave behind an unused dev server.
  if (job.finishedAt !== null) {
    console.log(`[intake-workflow] startAgentStep ${jobId} short-circuit: jobs row already finalized (exit ${job.exitCode}); workflow retry will not re-spawn`);
    return;
  }

  // Ensure the project's dev server is running for the duration of this
  // agent run (and any downstream release it triggers). Best-effort — log
  // and continue on failure so a flaky dev server start never blocks the
  // agent. The lifecycle module is idempotent; if a server is already up
  // (TamTam-owned or external), this is a no-op.
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, job.project));
    const row = rows[0];
    if (row?.devServerStartCommand) {
      const { ensureDevServerRunning } = await import('@/lib/dev-server/lifecycle');
      const r = await ensureDevServerRunning(
        job.project,
        {
          startCommand: row.devServerStartCommand,
          stopCommand: row.devServerStopCommand ?? null,
          readyUrl: row.devServerReadyUrl ?? null,
          cwd: projPath,
        },
        { startedByJobId: jobId },
      );
      if (r.status === 'spawn_failed' || r.status === 'ready_timeout') {
        console.warn(`[dev-server] start for ${job.project} returned ${r.status}; continuing without it`);
      }
    }
  } catch (e) {
    console.warn(`[dev-server] ensureDevServerRunning threw for ${job.project}:`, e);
  }

  // Write prereq artifact to disk.
  if (prereqArtifact) {
    try {
      writeFileSync(/*turbopackIgnore: true*/ prereqArtifact.path, prereqArtifact.body);
    } catch (e) {
      console.error('[intake-workflow] failed to write prereq artifact:', errMsg(e));
    }
  }

  // Preserve any keys the route added between `start()` returning and the
  // first step running (notably `workflowRunId`, written so the jobs DELETE
  // route can call `getRun(id).cancel()`). The compose step builds a fresh
  // context_meta from scratch; without this merge, the route's late write
  // would be silently clobbered here.
  try {
    const incoming = JSON.parse(contextMeta || '{}');
    const existing = JSON.parse(job.contextMeta || '{}');
    if (existing.workflowRunId && !incoming.workflowRunId) {
      incoming.workflowRunId = existing.workflowRunId;
    }
    job.contextMeta = JSON.stringify(incoming);
  } catch {
    job.contextMeta = contextMeta;
  }
  updateJob(job);

  try {
    const pid = await startInProcessAgentJob(jobId, cmd, fullPrompt, projPath, {
      env: cliEnv,
      fallback: fallback
        ? {
            provider: fallback.provider,
            command: fallback.cmd,
            env: fallback.cliEnv,
          }
        : undefined,
    });
    job.pid = pid;
    updateJob(job);
  } catch (e: unknown) {
    const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
    const logPath = job.logPath ?? '';
    if (logPath) appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# workflow: failed to start agent: ${errMsg(e)}\n`);
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    await markDone(job, -1);
    throw e;
  }
}
