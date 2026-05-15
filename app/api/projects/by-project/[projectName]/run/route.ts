import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess as startJob } from '@/lib/jobs/spawn-claude-detached';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { parseOptionalKnownModelInput, type ModelTier } from '@/lib/agents/model-aliases';
import { getSettings } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import { resolveAutoAttachedDocs, formatAutoAttachedDocsBlock } from '@/lib/skills/auto-attach-docs';

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

    const attachDir = join(process.cwd(), 'data', 'attachments');
    mkdirSync(attachDir, { recursive: true });

    for (const [, value] of form.entries()) {
      if (value instanceof File && value.name) {
        const ext = extname(value.name);
        const safeName = `${randomUUID().slice(0, 8)}${ext}`;
        const filePath = join(attachDir, safeName);
        const buffer = Buffer.from(await value.arrayBuffer());
        writeFileSync(filePath, buffer);
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

  const blockingJob = await findBlockingRunningJob(projectName);
  if (blockingJob) {
    return NextResponse.json({
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blocking_job_id: blockingJob.id,
    }, { status: 409 });
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
    const personaFile = existsSync(docsFile) ? docsFile : join(DATA_SKILLS_DIR, `${pPath}.md`);
    if (existsSync(personaFile)) {
      try {
        const personaContent = readFileSync(personaFile, 'utf-8');
        prompt = personaContent + '\n\n---\n\n' + prompt;
      } catch {}
    }
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

  const job = createJob(projectName, 'run', 0, '', prompt, contextMeta || undefined, userPrompt || undefined, ghIssueNumber, ghIssueRepo || null, ghIssueTitle || null);
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  let cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag()}`;
  if (resumeSessionId) {
    cmd += ` --resume ${resumeSessionId}`;
  }

  try {
    const pid = await startJob(
      job.id,
      cmd,
      prompt,
      projPath,
      { env: cliEnv }
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
  });
}
