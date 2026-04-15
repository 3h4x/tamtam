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
  let personaPath = '';
  const attachmentPaths: string[] = [];

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    prompt = (form.get('prompt') as string) ?? '';
    personaPath = (form.get('persona') as string) ?? '';

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
    personaPath = body.persona ?? '';
  }

  if (!prompt.trim()) {
    return NextResponse.json({ detail: 'Prompt is required' }, { status: 400 });
  }

  if (personaPath) {
    const personaFile = join(SKILLS_DIR, personaPath);
    if (existsSync(personaFile)) {
      try {
        const personaContent = readFileSync(personaFile, 'utf-8');
        prompt = personaContent + '\n\n---\n\n' + prompt;
      } catch {}
    }
  }

  if (attachmentPaths.length > 0) {
    prompt += '\n\nAttached files (read them to see their content):\n';
    for (const p of attachmentPaths) prompt += `- ${p}\n`;
  }

  const job = createJob(projectName, 'run', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --dangerously-skip-permissions`,
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
