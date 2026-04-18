import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { getImproveConfig } from '@/lib/scheduling';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills';
import { resolveProjectPath } from '@/lib/project-data';
import { createJob, updateJob } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/config';
import { errMsg } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const { claudeBin, logDir } = getImproveConfig();

  let prompt = '';
  let personaPaths: string[] = [];
  const attachmentPaths: string[] = [];
  let model = 'haiku';
  let resumeSessionId = '';
  let contextMeta = '';
  let userPrompt = '';
  const ALLOWED_MODELS = ['haiku', 'sonnet', 'opus'];

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    prompt = (form.get('prompt') as string) ?? '';
    const persona = form.get('persona') as string;
    if (persona) personaPaths = [persona];
    const personasJson = form.get('personas') as string;
    if (personasJson) { try { personaPaths = JSON.parse(personasJson) } catch {} }
    const formModel = (form.get('model') as string) ?? '';
    if (formModel && ALLOWED_MODELS.includes(formModel)) model = formModel;
    const formResumeId = form.get('resumeSessionId') as string;
    if (formResumeId) resumeSessionId = formResumeId;
    const formContextMeta = form.get('contextMeta') as string;
    if (formContextMeta) contextMeta = formContextMeta;
    const formUserPrompt = form.get('userPrompt') as string;
    if (formUserPrompt) userPrompt = formUserPrompt;

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
    const bodyModel = body.model ?? '';
    if (bodyModel && ALLOWED_MODELS.includes(bodyModel)) model = bodyModel;
    if (body.resumeSessionId) resumeSessionId = body.resumeSessionId;
    if (body.contextMeta) contextMeta = body.contextMeta;
    if (body.userPrompt) userPrompt = body.userPrompt;
  }

  if (!prompt.trim() && attachmentPaths.length === 0) {
    return NextResponse.json({ detail: 'Prompt is required' }, { status: 400 });
  }
  if (!prompt.trim() && attachmentPaths.length > 0) {
    prompt = 'See the attached files.';
  }

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
  if (!resumeSessionId) {
    prompt = withBasePrompt(prompt);
  }

  if (attachmentPaths.length > 0) {
    prompt += '\n\nAttached files (read them to see their content):\n';
    for (const p of attachmentPaths) prompt += `- ${p}\n`;
  }

  const job = createJob(projectName, 'run', 0, '', prompt, contextMeta || undefined, userPrompt || undefined);
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
      projPath
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
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
