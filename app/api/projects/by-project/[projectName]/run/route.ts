import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'fs';
import { join, sep } from 'path';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess as startJob } from '@/lib/jobs/spawn-claude-detached';
import { withBasePrompt, getPermissionModeFlag, VALID_PERMISSION_MODES } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { parseOptionalKnownModelInput, type ModelTier } from '@/lib/agents/model-aliases';
import { getSettings } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { enqueueTerminalRun, drainNextTerminalRun, TERMINAL_DRAIN_HEADER } from '@/lib/terminal/pending-terminal-run';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import { resolveAutoAttachedDocs, formatAutoAttachedDocsBlock } from '@/lib/skills/auto-attach-docs';
import {
  estimatePromptCost,
  promptEstimateResponseDetail,
} from '@/lib/jobs/prompt-size';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const { logDir } = getImproveConfig();

  let prompt = '';
  let personaPaths: string[] = [];
  const attachmentPaths: string[] = [];
  let model: ModelTier = 'fast';
  let resumeSessionId = '';
  let contextMeta = '';
  let userPrompt = '';
  let ghIssueNumber: number | null = null;
  let ghIssueRepo = '';
  let ghIssueTitle = '';
  let pinnedProvider = '';
  let permissionModeOverride = '';

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    prompt = (form.get('prompt') as string) ?? '';
    const persona = form.get('persona') as string;
    if (persona) personaPaths = [persona];
    const personasJson = form.get('personas') as string;
    if (personasJson) { try { personaPaths = JSON.parse(personasJson) } catch {} }
    const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(form.get('model'), 'fast');
    if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
    if (parsedModel) model = parsedModel;
    const formResumeId = form.get('resumeSessionId') as string;
    if (formResumeId) resumeSessionId = formResumeId;
    const formContextMeta = form.get('contextMeta') as string;
    if (formContextMeta) contextMeta = formContextMeta;
    const formUserPrompt = form.get('userPrompt') as string;
    if (formUserPrompt) userPrompt = formUserPrompt;
    const formIssueNumber = form.get('ghIssueNumber') as string;
    if (formIssueNumber) ghIssueNumber = parseInt(formIssueNumber, 10) || null;
    const formIssueRepo = form.get('ghIssueRepo') as string;
    if (formIssueRepo) ghIssueRepo = formIssueRepo;
    const formIssueTitle = form.get('ghIssueTitle') as string;
    if (formIssueTitle) ghIssueTitle = formIssueTitle;
    const formProvider = form.get('provider') as string;
    if (formProvider) pinnedProvider = formProvider;
    const formPermissionMode = form.get('permissionMode') as string;
    if (formPermissionMode) permissionModeOverride = formPermissionMode;

    const attachDir = join(process.cwd(), 'data', 'attachments');
    mkdirSync(/*turbopackIgnore: true*/ attachDir, { recursive: true });

    for (const [, value] of form.entries()) {
      if (value instanceof File && value.name) {
        const ext = extname(value.name);
        const safeName = `${randomUUID().slice(0, 8)}${ext}`;
        const filePath = join(attachDir, safeName);
        const buffer = Buffer.from(await value.arrayBuffer());
        writeFileSync(/*turbopackIgnore: true*/ filePath, buffer);
        attachmentPaths.push(filePath);
      }
    }
  } else {
    const body = await request.json();
    prompt = body.prompt ?? '';
    if (body.persona) personaPaths = [body.persona];
    if (body.personas) personaPaths = body.personas;
    const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(body.model, 'fast');
    if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
    if (parsedModel) model = parsedModel;
    if (body.resumeSessionId) resumeSessionId = body.resumeSessionId;
    if (body.contextMeta) contextMeta = body.contextMeta;
    if (body.userPrompt) userPrompt = body.userPrompt;
    if (body.ghIssueNumber != null) ghIssueNumber = Number(body.ghIssueNumber) || null;
    if (body.ghIssueRepo) ghIssueRepo = body.ghIssueRepo;
    if (body.ghIssueTitle) ghIssueTitle = body.ghIssueTitle;
    if (body.provider) pinnedProvider = String(body.provider);
    if (body.permissionMode) permissionModeOverride = String(body.permissionMode);
    // Internal replay only: a queued-terminal-run drain re-POSTs with the
    // attachment files already saved to disk, passing their paths directly
    // (the original multipart upload happened on the first, blocked request).
    // These paths land in the prompt as "read them", so honor them ONLY on a
    // drain replay (header set) AND only when each path resolves *inside* the
    // attachments dir. Without this, a client could set the header and pass
    // arbitrary filesystem paths to exfiltrate any file the server can read.
    // The header is client-settable, so the realpath containment check — not
    // the header alone — is the actual security boundary.
    if (request.headers.get(TERMINAL_DRAIN_HEADER) && Array.isArray(body.attachmentPaths)) {
      const attachRoot = join(process.cwd(), 'data', 'attachments');
      let realRoot: string | null = null;
      try { realRoot = realpathSync(/*turbopackIgnore: true*/ attachRoot); } catch { realRoot = null; }
      if (realRoot) {
        for (const p of body.attachmentPaths) {
          if (typeof p !== 'string' || !p) continue;
          let real: string;
          try { real = realpathSync(/*turbopackIgnore: true*/ p); } catch { continue; }
          if (real === realRoot || real.startsWith(realRoot + sep)) {
            attachmentPaths.push(real);
          }
        }
      }
    }
  }

  if (permissionModeOverride && !(VALID_PERMISSION_MODES as readonly string[]).includes(permissionModeOverride)) {
    return NextResponse.json({
      detail: `Invalid permissionMode. Allowed values: ${VALID_PERMISSION_MODES.join(', ')}`,
    }, { status: 400 });
  }
  if (!prompt.trim() && attachmentPaths.length === 0) {
    return NextResponse.json({ detail: 'Prompt is required' }, { status: 400 });
  }
  if (!prompt.trim() && attachmentPaths.length > 0) {
    prompt = 'See the attached files.';
  }
  if (ghIssueNumber != null && !ghIssueRepo.trim()) {
    return NextResponse.json({
      detail: 'ghIssueRepo is required when ghIssueNumber is set',
    }, { status: 400 });
  }

  // Preserve what the operator actually typed for list/detail UI. The
  // execution prompt is expanded below with personas, auto-attached docs,
  // and the shared base prompt, but history rows should still show the
  // original user-facing request when the caller didn't send userPrompt
  // separately.
  if (!userPrompt.trim()) {
    userPrompt = prompt;
  }

  const blockingJob = await findBlockingRunningJob(projectName);
  if (blockingJob) {
    // A drain replay (header set) must NOT re-enqueue — it lost the race to a
    // job that started between the drain's blocking-check and this point. Keep
    // the existing queue row by returning 409; the next finish-seam retries.
    const isDrainReplay = !!request.headers.get(TERMINAL_DRAIN_HEADER);
    if (isDrainReplay) {
      return NextResponse.json({
        detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
        blocking_job_id: blockingJob.id,
      }, { status: 409 });
    }
    // Normal request: queue the user's prompt instead of rejecting it. Captured
    // raw, before prompt composition, so a later replay recomposes identically.
    const { queueId, position } = await enqueueTerminalRun(projectName, {
      prompt,
      userPrompt: userPrompt || undefined,
      model,
      provider: pinnedProvider || undefined,
      permissionMode: permissionModeOverride || undefined,
      resumeSessionId: resumeSessionId || undefined,
      personas: personaPaths.length > 0 ? personaPaths : undefined,
      contextMeta: contextMeta || undefined,
      ghIssueNumber,
      ghIssueRepo: ghIssueRepo || undefined,
      ghIssueTitle: ghIssueTitle || undefined,
      attachmentPaths: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    });
    // Close the enqueue-after-blocker-finish race: if the blocker cleared in
    // the window between the check above and this insert, its completion-hook
    // drain already ran (and no-op'd on an empty queue), so nothing would
    // replay this row until the next finish-seam or a restart. Re-check and
    // kick the drain ourselves — the in-flight guard makes a redundant kick
    // safe, and a still-blocked project no-ops. Fire-and-forget so the 202
    // isn't delayed by the replay.
    void findBlockingRunningJob(projectName).then((stillBlocking) => {
      if (!stillBlocking) return drainNextTerminalRun(projectName);
    }).catch((e) => {
      console.error(`[pending-terminal-run] post-enqueue drain kick failed for ${projectName}:`, e);
    });
    return NextResponse.json({
      status: 'queued',
      queueId,
      position,
      blockingKind: blockingJob.kind,
      blocking_job_id: blockingJob.id,
    }, { status: 202 });
  }

  // When resuming, pin to the originating provider — session IDs are stored
  // per-CLI (codex rollouts ≠ claude sessions ≠ gemini threads), so a
  // cross-provider resume yields a cryptic "no rollout / session not found"
  // error from whichever CLI was picked by the budget gate.
  const preferredProvider = pinnedProvider && isCliProvider(pinnedProvider)
    ? pinnedProvider
    : undefined;
  const gate = await checkCliStartGate('start a terminal run', {
    preferred: preferredProvider,
    strictPreferred: !!preferredProvider,
    requestedModel: model,
    respectJobsPaused: false,
  });
  if (!gate.ok) {
    return NextResponse.json({ detail: gate.detail }, { status: gate.status });
  }
  if (preferredProvider && gate.provider !== preferredProvider) {
    return NextResponse.json({
      detail: `Cannot resume session on ${gate.provider}: original session ran on ${preferredProvider}, which is currently disabled or over budget. Start a new session or re-enable ${preferredProvider}.`,
    }, { status: 409 });
  }
  const provider = gate.provider;
  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  // Personas (file-based skills) are always prepended when selected in the
  // toolbar — initial turn or follow-up — so the user's mental model "if it's
  // in the +skill bar, it's in context" holds. The base prompt is only
  // injected on the initial turn.
  const docsBase = join(SKILLS_DIR, 'docs', 'skills');
  for (const pPath of personaPaths) {
    const docsFile = join(docsBase, `${pPath}.md`);
    try {
      let personaContent: string;
      try {
        personaContent = readFileSync(/*turbopackIgnore: true*/ docsFile, 'utf-8');
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        personaContent = readFileSync(/*turbopackIgnore: true*/ join(DATA_SKILLS_DIR, `${pPath}.md`), 'utf-8');
      }
      prompt = personaContent + '\n\n---\n\n' + prompt;
    } catch {}
  }
  let autoAttachedDocNames: string[] = [];
  if (!resumeSessionId) {
    const fileConfig = loadFileConfig(projPath);
    const autoDocs = resolveAutoAttachedDocs(projPath, userPrompt || prompt, fileConfig);
    if (autoDocs.length > 0) {
      const block = formatAutoAttachedDocsBlock(autoDocs);
      if (block) prompt = block + '\n\n---\n\n' + prompt;
      autoAttachedDocNames = autoDocs.map((d) => d.rulePath);
    }
    prompt = withBasePrompt(prompt, { projectPath: projPath, provider });
  }

  if (autoAttachedDocNames.length > 0) {
    try {
      const existing = contextMeta ? (JSON.parse(contextMeta) as Record<string, unknown>) : {};
      existing.autoAttachedDocs = autoAttachedDocNames;
      contextMeta = JSON.stringify(existing);
    } catch {
      contextMeta = JSON.stringify({ autoAttachedDocs: autoAttachedDocNames });
    }
  }

  if (attachmentPaths.length > 0) {
    prompt += '\n\nAttached files (read them to see their content):\n';
    for (const p of attachmentPaths) prompt += `- ${p}\n`;
  }

  const promptEstimate = estimatePromptCost(prompt, { modelTier: model });
  if (promptEstimate.blocked) {
    return NextResponse.json({
      code: 'prompt_estimate_blocked',
      detail: promptEstimateResponseDetail(promptEstimate),
      prompt_estimate: promptEstimate,
    }, { status: 413 });
  }

  // Issue runs work on their OWN branch from the start, not the default branch.
  // Check out fix/issue-<n> (cut fresh from origin/<default>) BEFORE creating the
  // job / spawning the agent, so its in-progress changes never sit exposed on the
  // default branch mid-run where a concurrent release/agent could sweep them up
  // (the commit-phase switch used to be the only branch point). ensureIssueBranch
  // is idempotent, honours the project's issue_auto_branch opt-out, and on failure
  // we log and let the run proceed on the current branch (commit-time switch is
  // the backstop).
  if (ghIssueNumber != null) {
    try {
      const { ensureIssueBranch } = await import('@/lib/github/issue-branch');
      const branchResult = await ensureIssueBranch({
        projectName,
        projPath,
        issueNumber: ghIssueNumber,
        issueTitle: ghIssueTitle ?? '',
      });
      if (branchResult.status === 'error' || branchResult.status === 'pipeline-running') {
        console.warn(`[run] ${projectName} issue-branch checkout not applied (${branchResult.status}); run proceeds on current branch`);
      }
    } catch (err) {
      console.error('[run] ensureIssueBranch threw; run proceeds on current branch:', err);
    }
  }

  const job = createJob(projectName, 'run', 0, '', prompt, contextMeta || undefined, userPrompt || undefined, ghIssueNumber, ghIssueRepo || null, ghIssueTitle || null);
  job.provider = provider;
  job.model = model;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  // When resuming an existing session, pin the session id on the row upfront.
  // markDone usually fills this in from the CLI's `result` event, but if the
  // run is killed (PM2 restart, manual cancel) before that event lands, the
  // terminal page would otherwise lose the link back to the session. The
  // CLI emits the same id on its own result event, so this is a no-op on
  // success and a recovery aid on failure.
  if (resumeSessionId) {
    job.sessionId = resumeSessionId;
  }

  let cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag(permissionModeOverride || null)}`;
  if (resumeSessionId) {
    cmd += ` --resume ${resumeSessionId}`;
  }

  // Wire the browser broker MCP into terminal runs the same way agent intake
  // does — without this, a manual terminal session has no `mcp__tamtam_browser__*`
  // tools even when `browser_broker_enabled` is on. The settings gate inside
  // prepareBrokerRun makes this a no-op when the broker is disabled.
  let mergedEnv = cliEnv;
  let broker: { env: Record<string, string>; cleanup: () => void } | null = null;
  try {
    const { prepareBrokerRun } = await import('@/lib/browser-broker/prepare-run');
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
    const projectRow = rows[0] ?? null;
    broker = await prepareBrokerRun({
      jobId: job.id,
      projectOrigins: {
        qaUrl: projectRow?.qaUrl ?? null,
        devServerReadyUrl: projectRow?.devServerReadyUrl ?? null,
        website: projectRow?.website ?? null,
      },
      provider,
    });
    if (broker) {
      mergedEnv = { ...cliEnv, ...broker.env };
    }
  } catch (e) {
    console.warn(`[terminal-run] broker prep failed for ${job.id}:`, e);
  }

  try {
    const pid = await startJob(
      job.id,
      cmd,
      prompt,
      projPath,
      { env: mergedEnv, cleanup: broker?.cleanup }
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return NextResponse.json({ detail: `Failed to start: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
    prompt_estimate: promptEstimate,
  });
}
