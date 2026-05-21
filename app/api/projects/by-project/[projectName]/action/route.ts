import { NextRequest, NextResponse } from 'next/server';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { spawn, type SpawnOptions } from 'child_process';
import { homedir } from 'os';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { buildChildEnv } from '@/lib/shared/child-env';
import { shellQuote } from '@/lib/shared/shell';
import { createJob, updateJob } from '@/lib/jobs/job-storage';
import { getSettings } from '@/lib/shared/config';
import { jobsPausedResult } from '@/lib/shared/job-control';
import { loadFileConfig, writeFileConfig } from '@/lib/skills/tamtam-file-config';

export interface CustomAction {
  name: string;
  command: string;
  color?: string;
}

/**
 * Custom actions are part of the team contract — read from `.tamtam/config.yml`
 * first so every teammate sees the same buttons. Fall back to the DB column
 * for projects that haven't migrated their actions to the file yet.
 */
async function getCustomActions(projectName: string): Promise<CustomAction[]> {
  const projPath = resolveProjectPath(projectName);
  if (projPath) {
    // If the file declares custom_actions (even as an empty array), it is
    // authoritative — do not fall back to the DB.
    const fileCfg = loadFileConfig(projPath);
    if (fileCfg?.custom_actions !== undefined) return fileCfg.custom_actions;
  }
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .limit(1);
  const row = rows[0];
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
  return NextResponse.json({ actions: await getCustomActions(projectName) });
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

  await db.update(schema.projects)
    .set({ customActions: JSON.stringify(actions) })
    .where(eq(schema.projects.name, projectName))
    .execute();

  // Mirror to .tamtam/config.yml so teammates pick up new buttons on pull.
  // DB write is the source of truth for performance/cache; the file is the
  // version-controlled artifact. An empty array is written verbatim (rather
  // than removing the key) so that committing "no actions" actively clears
  // teammates' DB-stored actions on pull, instead of silently falling back
  // to whatever each teammate has locally.
  const projPath = resolveProjectPath(projectName);
  if (projPath) {
    try {
      writeFileConfig(projPath, { custom_actions: actions });
    } catch { /* non-fatal — DB already has the new state */ }
  }

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

  const paused = jobsPausedResult(`run custom action "${actionName}"`);
  if (paused) {
    return NextResponse.json({ detail: paused.detail }, { status: paused.status });
  }

  const actions = await getCustomActions(projectName);
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
  const redactScriptPath = resolve(process.cwd(), 'scripts', 'redact-log-stream.js');
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const job = createJob(projectName, actionName, 0, '');
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  const bashCommand = [
    '#!/bin/bash',
    'set -o pipefail',
    '{',
    `  ${action.command}`,
    `} 2>&1 | node ${shellQuote(redactScriptPath)} ${shellQuote(logPath)}`,
    'exit ${PIPESTATUS[0]}',
  ].join('\n');
  writeFileSync(/*turbopackIgnore: true*/ logPath, '');

  const proc = spawn('bash', ['-lc', bashCommand], {
    cwd: projPath,
    stdio: 'ignore' as SpawnOptions['stdio'],
    env: buildChildEnv(),
    detached: true,
  });

  job.pid = proc.pid ?? 0;

  proc.on('close', (code: number | null) => {
    job.exitCode = code ?? -1;
    job.finishedAt = Date.now() / 1000;
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
