import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { openSync } from 'fs';
import { spawn, type SpawnOptions } from 'child_process';
import { homedir } from 'os';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/project-data';
import { createJob, updateJob } from '@/lib/job-storage';
import { getSettings } from '@/lib/config';

export interface CustomAction {
  name: string;
  command: string;
  color?: string;
}

function getCustomActions(projectName: string): CustomAction[] {
  const row = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .get();
  if (!row?.customActions) return [];
  try {
    return JSON.parse(row.customActions);
  } catch {
    return [];
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  return NextResponse.json({ actions: getCustomActions(projectName) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json();
  const actions = body.actions as CustomAction[];

  if (!Array.isArray(actions)) {
    return NextResponse.json({ detail: 'actions must be an array' }, { status: 400 });
  }

  for (const a of actions) {
    if (!a.name || !a.command) {
      return NextResponse.json({ detail: 'each action must have name and command' }, { status: 400 });
    }
  }

  db.update(schema.projects)
    .set({ customActions: JSON.stringify(actions) })
    .where(eq(schema.projects.name, projectName))
    .run();

  return NextResponse.json({ status: 'ok', actions });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json();
  const actionName = body.action as string;

  if (!actionName) {
    return NextResponse.json({ detail: 'action name is required' }, { status: 400 });
  }

  const actions = getCustomActions(projectName);
  const action = actions.find((a) => a.name === actionName);
  if (!action) {
    return NextResponse.json({ detail: `action '${actionName}' not found` }, { status: 404 });
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const { log_dir } = getSettings();
  const logDir = log_dir.startsWith('~') ? join(homedir(), log_dir.slice(2)) : log_dir;
  const { mkdirSync } = await import('fs');
  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, actionName, 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  const logFd = openSync(logPath, 'w');
  const proc = spawn('bash', ['-c', action.command], {
    cwd: projPath,
    stdio: ['ignore', logFd, logFd] as SpawnOptions['stdio'],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k, v]) => v !== undefined && !k.startsWith('npm_') && !k.startsWith('PNPM_') && k !== 'NODE_PATH'
        )
      ),
      HOME: homedir(),
    } as unknown as NodeJS.ProcessEnv,
    detached: true,
  });

  job.pid = proc.pid ?? 0;

  proc.on('exit', (code: number | null) => {
    job.exitCode = code ?? -1;
    job.finishedAt = Date.now() / 1000;
    const { closeSync } = require('fs');
    try { closeSync(logFd); } catch {}
    updateJob(job);
  });

  proc.unref();
  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    action: actionName,
  });
}
