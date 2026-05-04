import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { exec } from '@/lib/shared/shell';
import { getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'fix-ci' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return NextResponse.json(
        { detail: `CI fix already in progress for ${projectName}` },
        { status: 409 }
      );
    }
  }

  const { projects, logDir } = getImproveConfig();
  const settings = getSettings();
  const { github_owner: dbGithubOwner } = settings;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  const preferredProviderHeader = request.headers.get('x-tamtam-provider-preferred');
  const gate = await checkCliStartGate('start a CI fix', {
    preferred: isCliProvider(preferredProviderHeader) ? preferredProviderHeader : null,
  });
  if (!gate.ok) return NextResponse.json({ detail: gate.detail }, { status: gate.status });
  const provider = gate.provider;
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const defaultModel = resolveCliDefaultModel(provider, settings);

  const owner = process.env.GITHUB_OWNER || dbGithubOwner || projectName;
  let repo = `${owner}/${projectName}`;
  for (const cfg of Object.values(projects)) {
    if (cfg.project === projectName && cfg.github) {
      repo = cfg.github;
      break;
    }
  }

  // Get CI failure URL from DB
  const { db, schema } = await import('@/lib/db');
  const { eq } = await import('drizzle-orm');
  const ciEntry = db.select().from(schema.ghStatus).where(eq(schema.ghStatus.project, projectName)).get();
  const ciFailedUrl = ciEntry?.ciFailedUrl;
  if (!ciFailedUrl) {
    return NextResponse.json({ detail: 'No failed CI URL found' }, { status: 400 });
  }

  const runIdMatch = ciFailedUrl.match(/\/runs\/(\d+)/);
  const runId = runIdMatch?.[1];

  let ciLogs = '';
  if (runId) {
    const r = await exec('gh', ['run', 'view', runId, '--repo', repo, '--log-failed'], { timeout: 30000 });
    ciLogs = r.exitCode === 0 ? r.stdout.trim() : r.stderr.trim();
  }
  if (!ciLogs) {
    return NextResponse.json({ detail: 'Could not fetch CI failure logs' }, { status: 500 });
  }
  if (ciLogs.length > 8000) ciLogs = '...(truncated)...\n' + ciLogs.slice(-8000);

  const prompt = `GitHub Actions CI is failing for the \`${projectName}\` project.

Failed run: ${ciFailedUrl}

## Failure logs

\`\`\`
${ciLogs}
\`\`\`

Please analyse the logs, identify the root cause, and fix the issue in the codebase.
After fixing, run the relevant tests or linter locally to confirm the fix works.
Do not commit — just make the code changes.
`;

  const job = createJob(projectName, 'fix-ci', 0, '');
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${defaultModel} ${getPermissionModeFlag()}`,
      prompt,
      projPath,
      { env: cliEnv }
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return NextResponse.json({ detail: `Failed to start CI fix: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
    ci_url: ciFailedUrl,
  });
}
