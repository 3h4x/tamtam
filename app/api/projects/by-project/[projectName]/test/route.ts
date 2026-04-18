import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { getImproveConfig } from '@/lib/scheduling';
import { resolveProjectPath } from '@/lib/project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from '@/lib/job-storage';

function detectTestCommand(projPath: string, projectName?: string): string | null {
  if (projectName) {
    const { projects } = getImproveConfig();
    for (const cfg of Object.values(projects)) {
      if (cfg.project === projectName && cfg.test_command) return cfg.test_command;
    }
  }
  if (existsSync(join(projPath, 'pyproject.toml')) || existsSync(join(projPath, 'requirements.txt'))) {
    return 'python -m pytest';
  }
  const pkgJson = join(projPath, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      if (pkg.scripts?.test) {
        return existsSync(join(projPath, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
      }
    } catch {}
  }
  if (existsSync(join(projPath, 'foundry.toml'))) return 'forge test';
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'test' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return NextResponse.json(
        { detail: `Tests already running for ${projectName}` },
        { status: 409 }
      );
    }
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const { logDir } = getImproveConfig();

  const testCmd = detectTestCommand(projPath, projectName);
  if (!testCmd) {
    return NextResponse.json({ detail: `Could not detect test command for ${projectName}` }, { status: 400 });
  }

  const { mkdirSync } = await import('fs');
  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'test', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  const scriptPath = join(logDir, `${job.id}.sh`);
  writeFileSync(scriptPath, [
    '#!/bin/bash',
    `export PATH="${process.env.PATH || ''}"`,
    `export HOME="${homedir()}"`,
    `cd "${projPath}"`,
    `echo "Running: ${testCmd}"`,
    'echo "---"',
    `${testCmd} 2>&1`,
  ].join('\n'));
  chmodSync(scriptPath, 0o755);

  const { openSync } = await import('fs');
  const logFd = openSync(logPath, 'w');
  const proc = spawn('bash', [scriptPath], {
    cwd: projPath,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });

  job.pid = proc.pid ?? 0;
  proc.unref();
  updateJob(job);

  proc.on('exit', (code) => {
    job.exitCode = code ?? -1;
    job.finishedAt = Date.now() / 1000;
    updateJob(job);
    const { closeSync } = require('fs');
    try { closeSync(logFd); } catch {}
  });

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
    test_cmd: testCmd,
  });
}
