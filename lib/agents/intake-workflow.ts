import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { withBasePrompt, getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import {
  buildMemoryBlock,
  readAgentMemoryDetailed,
  getAgentMemoryPath,
  ensureAgentMemoryDir,
} from '@/lib/agents/agent-memory';
import { exec } from '@/lib/shared/shell';
import { isCanonicalModelTier, normalizeModelInput } from '@/lib/agents/model-aliases';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';
import { hasIssueCruncherSkill } from '@/lib/agents/prerequisites';
import { parseIssueStamp } from '@/lib/agents/issue-stamp';
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
  /** Per-agent permission-mode override; null → inherit the global setting. */
  permissionMode?: string | null;
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
  skillIds: string;
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

  // Bridge the post-prerequisite window. composePromptStep runs next (skill
  // compose, git reads, retrieval) with the main child not yet spawned, so the
  // job row still has pid=0. The prereq's cancellation signal was just cleared
  // (finishJobCancellation above), and a non-trivial prereq always leaves the
  // job older than probeJobStatus's PID_SPAWN_GRACE — so without a guard the
  // 30s probe sweep sees pid<=0, past grace, no inline signal and markDone(-1)s
  // the job mid-composition (the dominant cause of prereq-bearing agents dying
  // at ~prereq-length with no model output). Adopt the inline-server pid
  // convention (see lib/jobs/inline-agent.ts): point pid at the server process
  // so the probe treats this as a self-finalizing inline step until the real
  // child pid lands. startInProcessAgentJob overwrites pid on spawn, and every
  // composePromptStep skip path finalizes the row explicitly, so this cannot
  // strand the job.
  const bridgeJob = getJob(jobId);
  if (bridgeJob && bridgeJob.finishedAt === null) {
    bridgeJob.pid = process.pid;
    updateJob(bridgeJob);
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
    permissionMode,
  } = params;

  // Stamp the issue-cruncher's pick_top-chosen issue onto the job row. The
  // scheduled issue-cruncher SELECTS its issue at runtime (the prereq), so the
  // job is never pre-stamped — without this it stays ghIssueNumber=null and the
  // action orchestrator (lib/agents/action-eligibility) skips EVERY issue-close/
  // comment/label it emits as "missing-issue-context" (an already-resolved issue
  // gets a correct close decision that silently never executes). Stamping makes
  // those actions dispatch, binds them to the chosen issue (issue-mismatch
  // guard), and lets the commit-time fix-branch backstop fire.
  if (prereqResult && hasIssueCruncherSkill(skillIds)) {
    const stamp = parseIssueStamp(prereqResult.stdout);
    if (stamp) {
      const { getJob } = await import('@/lib/jobs/job-storage');
      const j = getJob(jobId);
      if (j && j.finishedAt === null) {
        j.ghIssueNumber = stamp.number;
        if (stamp.title) j.ghIssueTitle = stamp.title;
        if (stamp.repo) j.ghIssueRepo = stamp.repo;
        updateJob(j);
      }
    }
  }

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
          modelOverride: isCanonicalModelTier(model) ? model : undefined,
          enqueuedAt: Date.now(),
        });
      } catch (err) {
        console.error('[intake-workflow] failed to persist post-prereq release-lock queue entry:', err);
        const j = getJob(jobId);
        if (j) { j.exitCode = 1; await markDone(j, 1); }
        return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, skillIds: '[]', prereqArtifact: null };
      }
      appendRedactedFileSync(
        /*turbopackIgnore: true*/ logPath,
        `\n# queued behind release pipeline lock — will run when lock releases\n`,
      );
      const j = getJob(jobId);
      if (j) { j.finishedAt = Date.now() / 1000; j.exitCode = 0; updateJob(j); await markDone(j, 0); }
      return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, skillIds: '[]', prereqArtifact: null };
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
        return { skipped: true, fullPrompt: '', cmd: '', cliEnv: {}, provider: 'claude', fallback: null, contextMeta: baseContextMeta, skillIds: '[]', prereqArtifact: null };
      }
    }
  }

  // All three are independent — `composeAgentSkills` reads skill files from
  // disk, the two git execs read from the worktree. Running them in one
  // Promise.all collapses sequential awaits to a single round-trip.
  const [composed, headR, statusR] = await Promise.all([
    composeAgentSkills(projPath, skillIds, docPaths),
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

  // Malformed baseContextMeta shouldn't kill the whole intake — fall back to
  // empty context and let the workflow continue. The route is responsible for
  // passing valid JSON; this is belt-and-suspenders.
  let baseCtx: Record<string, unknown> = {};
  try { baseCtx = JSON.parse(baseContextMeta) as Record<string, unknown>; } catch { /* default empty */ }
  // The run route seeds `agent.schedule` into baseContextMeta; preserve it here
  // so the finalizer's schedule-backoff detector can fire. Rebuilding the agent
  // block from id/name/triggeredBy alone (the prior behavior) silently dropped
  // the schedule, leaving `maybeRecommendSchedule` permanently inert — idle
  // agents were then mislabeled `agent_unfruitful` instead of getting the
  // correct "run less often" recommendation.
  const baseAgentSchedule =
    (baseCtx.agent as { schedule?: string | null } | undefined)?.schedule ?? null;
  const baseAgentRole =
    (baseCtx.agent as { role?: string } | undefined)?.role ?? 'producer';
  const contextMetaObj: Record<string, unknown> = {
    ...baseCtx,
    skills: composed.metaSkills,
    docs: composed.metaDocs,
    agent: { id: agentId, name: agentName, triggeredBy, schedule: baseAgentSchedule, role: baseAgentRole },
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

  // When skills/personas/docs are attached, prepend a precedence header so
  // the model resolves conflicts the same way every time: project
  // instructions (CLAUDE.md, loaded either implicitly by the CLI or via
  // `withBasePrompt`) win, and skills/personas are treated as role framing
  // and tactical guidance, not the final word on project conventions. This
  // closes the ambiguity surfaced when a vendored persona (e.g. Fullstack
  // Engineer) restates rules that the project's own CLAUDE.md also covers.
  const precedenceHeader = allParts.length > 0
    ? 'Conflict resolution: the project\'s `CLAUDE.md` (loaded by the CLI or shown above as "Project instructions from CLAUDE.md") is authoritative for this codebase. The skills, personas, and docs below add role framing, end-to-end checklists, and tactical guidance. When any of them conflicts with `CLAUDE.md`, follow `CLAUDE.md`.'
    : null;
  const systemPrompt = [precedenceHeader, ...allParts, autoAttachBlock, prereqBlock, reportContract].filter(Boolean).join('\n\n---\n\n');
  const corePrompt =
    systemPrompt && taskPrompt
      ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
      : systemPrompt || taskPrompt;

  let memoryDetail: ReturnType<typeof readAgentMemoryDetailed> = null;
  const memoryBlock = readOnly
    ? null
    : (() => {
        ensureAgentMemoryDir(projPath);
        const memoryPath = getAgentMemoryPath(projPath, agentName);
        memoryDetail = readAgentMemoryDetailed(projPath, agentName);
        return buildMemoryBlock(memoryPath, memoryDetail?.content ?? null, {
          truncated: memoryDetail?.truncated ?? false,
          rawChars: memoryDetail?.rawChars,
        });
      })();

  // Retrieval context (pgvector, if enabled).
  let retrievedContext: string | null = null;
  let retrievalStatusLabel = 'disabled';
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
      // Persist full diagnostics every run so the operator can see why
      // retrieval did or didn't contribute after-the-fact.
      contextMetaObj.retrieval = retrieval.diagnostics;
      retrievalStatusLabel = formatRetrievalStatus(retrieval.diagnostics);
    } catch (e) {
      console.warn('[intake-workflow] retrieval failed, skipping:', errMsg(e));
      retrievalStatusLabel = `errored (${errMsg(e)})`;
    }
  } else if (!settings.retrieval_enabled) {
    retrievalStatusLabel = 'disabled (retrieval_enabled=false)';
  } else {
    retrievalStatusLabel = 'skipped (no task prompt)';
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
  const permissionModeFlag = getPermissionModeFlag(permissionMode);
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${permissionModeFlag} ${modelFlag}${issueCruncherDenyFlag}`;
  const fallbackProvider = await resolveFallbackProvider({
    enabled: fallbackEnabled,
    currentProvider: safeProvider,
    requestedModel,
    respectJobsPaused: triggeredBy === 'schedule',
    isScheduled: triggeredBy === 'schedule',
    settings,
  });
  const fallback = fallbackProvider
    ? {
        provider: fallbackProvider,
        cmd: `${resolveCliBin(fallbackProvider, settings)} --print --output-format stream-json --include-partial-messages --verbose ${permissionModeFlag} ${modelFlag}${issueCruncherDenyFlag}`,
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

  const promptWithMemory = memoryBlock
    ? `${promptWithRetrieval}\n\n---\n\n${memoryBlock}`
    : promptWithRetrieval;

  const promptWithBase = withBasePrompt(promptWithMemory, {
    projectPath: projPath,
    provider: safeProvider,
  });

  // Composition marker: explicit summary of what's loaded into this
  // prompt so a human reading the `.prompt` artifact (or the model
  // itself) can tell composition mode at a glance, without inferring
  // anything from byte count. Sits at the very top so it's read first.
  const compositionMarker = buildAgentCompositionMarker({
    mode: 'fresh',
    provider: safeProvider,
    skillNames: composed.metaSkills.map((s) => s.name),
    docNames: composed.metaDocs.map((d) => d.name),
    autoAttachedCount: autoAttachedDocPaths.length,
    retrievalStatus: retrievalStatusLabel,
    memoryStatus: readOnly
      ? 'disabled (readonly run)'
      : memoryDetail === null
        ? 'empty (first run)'
        : memoryDetail.truncated
          ? `present, TRUNCATED (${memoryDetail.rawChars} chars on disk, cap 2000)`
          : `present (${memoryDetail.rawChars} chars)`,
    hasPrereq: Boolean(prereqResult),
  });
  // Persist a structured composition record in contextMeta so the per-project
  // prompt-insights endpoint can aggregate without re-parsing the marker text
  // from the `.prompt` artifact. Keep it small — high-cardinality lists go
  // through the existing skills/docs metadata.
  contextMetaObj.composition = {
    mode: 'fresh',
    provider: safeProvider,
    skillCount: composed.metaSkills.length,
    attachedDocCount: composed.metaDocs.length,
    autoAttachedCount: autoAttachedDocPaths.length,
    memory: readOnly
      ? { state: 'disabled', truncated: false, rawChars: 0 }
      : memoryDetail === null
        ? { state: 'empty', truncated: false, rawChars: 0 }
        : { state: 'present', truncated: memoryDetail.truncated, rawChars: memoryDetail.rawChars },
    hasPrereq: Boolean(prereqResult),
  };
  const fullPrompt = `${compositionMarker}\n\n---\n\n${promptWithBase}`;

  return {
    skipped: false,
    fullPrompt,
    cmd,
    cliEnv,
    provider: safeProvider,
    fallback,
    contextMeta: JSON.stringify(contextMetaObj),
    skillIds: JSON.stringify(composed.metaSkills.map((s) => ({
      id: s.id,
      name: s.name,
      promptChars: s.promptChars,
      source: s.source,
    }))),
    prereqArtifact,
  };
}

interface AgentCompositionMarkerInput {
  mode: 'fresh' | 'resumed' | 'hydrated';
  provider: string;
  skillNames: string[];
  docNames: string[];
  autoAttachedCount: number;
  retrievalStatus: string;
  memoryStatus: string;
  hasPrereq: boolean;
}

function buildAgentCompositionMarker(input: AgentCompositionMarkerInput): string {
  const lines = [
    '## Composition',
    `- mode: ${input.mode}`,
    `- provider: ${input.provider}`,
    `- skills: ${input.skillNames.length > 0 ? `${input.skillNames.length} (${input.skillNames.join(', ')})` : 'none'}`,
    `- attached docs: ${input.docNames.length > 0 ? `${input.docNames.length} (${input.docNames.join(', ')})` : 'none'}`,
    `- auto-attached docs: ${input.autoAttachedCount > 0 ? input.autoAttachedCount : 'none'}`,
    `- retrieval: ${input.retrievalStatus}`,
    `- memory: ${input.memoryStatus}`,
    `- prerequisite output: ${input.hasPrereq ? 'included' : 'not used'}`,
  ];
  return lines.join('\n');
}

function formatRetrievalStatus(d: {
  status: string;
  reason: string;
  corpusChunkCount: number;
  retrievedCount: number;
  acceptedCount: number;
  topScore: number | null;
  scoreThreshold: number;
}): string {
  if (d.reason === 'empty_corpus') return 'queried, empty corpus (no indexed chunks for this project)';
  if (d.reason === 'embed_failed') return 'errored (embedding call failed — check Ollama)';
  if (d.reason === 'no_results') return `queried, no nearest neighbours returned (corpus=${d.corpusChunkCount})`;
  if (d.reason === 'below_threshold') {
    const top = d.topScore !== null ? d.topScore.toFixed(3) : '?';
    return `queried, all ${d.retrievedCount} candidates below threshold (top=${top}, threshold=${d.scoreThreshold})`;
  }
  if (d.reason === 'results') {
    const top = d.topScore !== null ? d.topScore.toFixed(3) : '?';
    return `included ${d.acceptedCount} chunks (top score=${top}, threshold=${d.scoreThreshold})`;
  }
  return `${d.status} (${d.reason})`;
}

async function resolveFallbackProvider({
  enabled,
  currentProvider,
  requestedModel,
  respectJobsPaused,
  isScheduled,
  settings,
}: {
  enabled: boolean;
  currentProvider: CliProvider;
  requestedModel: ReturnType<typeof normalizeModelInput> | null;
  respectJobsPaused: boolean;
  isScheduled: boolean;
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
    isScheduled,
  });
  return gate.ok ? gate.provider : null;
}

async function startAgentStep(
  jobId: string,
  projPath: string,
  composed: ComposeResult,
): Promise<void> {
  'use step';

  const { fullPrompt, cmd, cliEnv, contextMeta, skillIds, prereqArtifact, fallback } = composed;

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

  // Issue runs work on their OWN branch from the start, not on the default
  // branch. Switch to fix/issue-<n> (cut fresh from origin/<default>) BEFORE the
  // agent process spawns — otherwise the agent edits the default branch's working
  // tree for the whole run and a concurrent release / another agent can sweep up
  // its half-finished changes (the branch switch used to happen only at commit
  // time, leaving issue work exposed on master mid-run). ensureIssueBranch is
  // idempotent (already-on-branch → no-op, e.g. the issue-cruncher path that
  // already checked out via pick_top), honours the project's issue_auto_branch
  // opt-out, and on any failure we log and let the agent run on the current
  // branch (the commit-time switch remains as the backstop).
  if (job.ghIssueNumber != null) {
    try {
      const { ensureIssueBranch } = await import('@/lib/github/issue-branch');
      const r = await ensureIssueBranch({
        projectName: job.project,
        projPath,
        issueNumber: job.ghIssueNumber,
        issueTitle: job.ghIssueTitle ?? '',
      });
      if (r.status === 'created' || r.status === 'reused') {
        console.log(`[intake-workflow] ${jobId}: issue run isolated on branch ${r.branch} (${r.status}) before spawn`);
      } else if (r.status === 'error' || r.status === 'pipeline-running') {
        console.warn(`[intake-workflow] ${jobId}: issue-branch checkout not applied (${r.status}); agent runs on current branch`);
      }
    } catch (err) {
      console.warn(`[intake-workflow] ${jobId}: ensureIssueBranch threw; agent runs on current branch:`, err);
    }
  }

  // Ensure the project's dev server is running for the duration of this
  // agent run (and any downstream release it triggers). Best-effort — log
  // and continue on failure so a flaky dev server start never blocks the
  // agent. The lifecycle module is idempotent; if a server is already up
  // (TamTam-owned or external), this is a no-op.
  let projectRow: {
    qaUrl: string | null;
    website: string | null;
    devServerReadyUrl: string | null;
  } | null = null;
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, job.project));
    const row = rows[0];
    if (row) {
      projectRow = {
        qaUrl: row.qaUrl ?? null,
        website: row.website ?? null,
        devServerReadyUrl: row.devServerReadyUrl ?? null,
      };
    }
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

  // Browser broker: when enabled in settings, spin up (or attach to) the
  // shared Playwright MCP container and inject per-run MCP config + env so
  // the spawned agent can drive Chromium via mcp__tamtam_browser__*.
  let broker: { env: Record<string, string>; cleanup: (() => void) | undefined } | null = null;
  try {
    const { prepareBrokerRun } = await import('@/lib/browser-broker/prepare-run');
    broker = await prepareBrokerRun({
      jobId,
      projectOrigins: {
        qaUrl: projectRow?.qaUrl ?? null,
        devServerReadyUrl: projectRow?.devServerReadyUrl ?? null,
        website: projectRow?.website ?? null,
      },
      provider: composed.provider,
    });
  } catch (e) {
    console.warn(`[intake-workflow] broker prep failed for ${jobId}; continuing without MCP injection:`, errMsg(e));
  }

  try {
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
    job.skillIds = skillIds;
    updateJob(job);

    const mergedEnv: Record<string, string> = { ...cliEnv, ...(broker?.env ?? {}) };
    const fallbackEnv = fallback
      ? { ...fallback.cliEnv, ...(broker?.env ?? {}) }
      : undefined;
    const pid = await startInProcessAgentJob(jobId, cmd, fullPrompt, projPath, {
      env: mergedEnv,
      fallback: fallback
        ? {
            provider: fallback.provider,
            command: fallback.cmd,
            env: fallbackEnv,
          }
        : undefined,
      cleanup: broker?.cleanup,
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
