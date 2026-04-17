import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { checkAuth } from '@/lib/auth';
import { getImproveConfig } from '@/lib/scheduling';
import { SKILLS_DIR } from '@/lib/skills';
import { resolveProjectPath } from '@/lib/project-data';
import { createJob, updateJob } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/config';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
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

    const attachDir = join(logDir, 'attachments');
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

  // For follow-ups (--resume), skip persona/base prompt injection — context is already in the session.
  // Attachments, however, MUST always be referenced in the prompt so Claude knows to open them.
  if (!resumeSessionId) {
    const docsBase = join(SKILLS_DIR, 'docs', 'skills');
    for (const pPath of personaPaths) {
      const personaFile = join(docsBase, `${pPath}.md`);
      if (existsSync(personaFile)) {
        try {
          const personaContent = readFileSync(personaFile, 'utf-8');
          prompt = personaContent + '\n\n---\n\n' + prompt;
        } catch {}
      }
    }
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
  } catch (e: any) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    return NextResponse.json({ detail: `Failed to start: ${e.message}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
  });
}
