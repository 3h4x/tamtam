import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess as startJob } from '@/lib/jobs/spawn-claude-detached';
import { exec } from '@/lib/shared/shell';
import { getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { extractGithubRepoFromUrl, resolveGithubRepo } from '@/lib/shared/gh-status';
import { db, schema } from '@/lib/db';

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

  const blockingJob = await findBlockingRunningJob(
    projectName,
    (job) => job.kind !== 'fix-ci',
  );
  if (blockingJob) {
    return NextResponse.json({
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blocking_job_id: blockingJob.id,
    }, { status: 409 });
  }

  const { projects, logDir } = getImproveConfig();
  const settings = getSettings();
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

  // Get CI failure URL from DB
  const ciEntry = (await db.select().from(schema.ghStatus).where(eq(schema.ghStatus.project, projectName)).limit(1))[0] ?? null;
  const ciFailedUrl = ciEntry?.ciFailedUrl;
  if (!ciFailedUrl) {
    return NextResponse.json({ detail: 'No failed CI URL found' }, { status: 400 });
  }

  const runIdMatch = ciFailedUrl.match(/\/runs\/(\d+)/);
  const runId = runIdMatch?.[1];
  const projectCfg = Object.values(projects).find((cfg) => cfg.project === projectName);
  const repo = extractGithubRepoFromUrl(ciFailedUrl)
    ?? await resolveGithubRepo(projectName, { github: projectCfg?.github ?? null, path: projPath });

  let ciLogs = '';
  if (runId) {
    const r = await exec('gh', ['run', 'view', runId, '--repo', repo, '--log-failed'], { timeout: 30000 });
    if (r.exitCode !== 0) {
      // Don't fall back to stderr here — `gh` errors (rate limit, auth, run
      // gone) bear no resemblance to the CI logs Claude needs to fix the
      // failure. Surface the gh error so the operator knows what broke
      // instead of asking Claude to "fix" garbage prose.
      return NextResponse.json(
        { detail: `gh run view failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || 'no detail'}` },
        { status: 502 },
      );
    }
    ciLogs = r.stdout.trim();
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
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    // fix-ci must reproduce the CI failure locally — install deps, build, run
    // tests/linters — to confirm the fix actually works (the prompt above asks
    // for exactly that). Under the default `auto` mode the Codex sandbox
    // (`workspace-write`) blocks outbound network, so `pnpm install` fails with
    // ENOTFOUND and the agent edits blind: it ships an unverified change and,
    // with auto-fix-ci on a red default branch, loops. `bypassPermissions` is
    // the only permission mode that grants the network access this job
    // fundamentally needs (Codex `--dangerously-bypass-approvals-and-sandbox`).
    // Gated on `fix_ci_bypass_sandbox` (default on) so the operator keeps a kill
    // switch for this scoped escalation; the global `permission_mode` still
    // governs every other job kind. When `tamtam_network_policy_strict` is on
    // the outer loopback seatbelt still applies by design — that lockdown is a
    // deliberate operator choice and fix-ci must then rely on pre-installed deps.
    const permissionMode = getPermissionModeFlag(
      settings.fix_ci_bypass_sandbox ? 'bypassPermissions' : undefined,
    );
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${defaultModel} ${permissionMode}`,
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
