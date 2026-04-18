import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling';
import { resolveProjectPath } from '@/lib/project-data';
import { getJob, createJob, readLog, probeJobStatus, updateJob } from '@/lib/job-storage';
import { getPermissionModeFlag } from '@/lib/config';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  const sourceJob = getJob(jobId);
  if (!sourceJob) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  if ((await probeJobStatus(sourceJob)) === 'running') {
    return NextResponse.json({ detail: 'Job is still running' }, { status: 400 });
  }

  let logOutput = readLog(sourceJob);
  if (!logOutput.trim()) {
    return NextResponse.json({ detail: 'No output to fix from' }, { status: 400 });
  }
  if (logOutput.length > 12000) {
    logOutput = '...(truncated)...\n' + logOutput.slice(-12000);
  }

  const projectName = sourceJob.project;
  const { claudeBin, logDir } = getImproveConfig();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const prompt = `A previous ${sourceJob.kind} job for \`${projectName}\` produced the following output:

\`\`\`
${logOutput}
\`\`\`

Please fix ALL the issues identified above. Apply the changes directly to the codebase.
After fixing, run the relevant tests or linter locally to confirm the fixes work.
Do not commit — just make the code changes.
`;

  const { mkdirSync, openSync } = await import('fs');
  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'fix', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  const logFd = openSync(logPath, 'w');
  const proc = spawn(claudeBin, ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...getPermissionModeFlag().split(' ')], {
    cwd: projPath,
    stdio: ['pipe', logFd, logFd],
    env: {
      ...process.env,
      PATH: `${join(homedir(), 'Library', 'pnpm')}:${process.env.PATH ?? ''}`,
      HOME: homedir(),
    },
    detached: true,
  });

  job.pid = proc.pid ?? 0;
  proc.unref();
  updateJob(job);

  try {
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } catch {}

  proc.on('exit', (code) => {
    job.exitCode = code ?? -1;
    job.finishedAt = Date.now() / 1000;
    const { closeSync } = require('fs');
    try { closeSync(logFd); } catch {}
  });

  return NextResponse.json({ status: 'started', job_id: job.id, pid: job.pid });
}
