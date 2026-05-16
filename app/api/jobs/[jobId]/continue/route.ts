import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getJob, createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess } from '@/lib/jobs/spawn-claude-detached';
import { getPermissionModeFlag, getSettings, withBasePrompt } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';

// How recently the source job must have finished to allow a --resume.
// Beyond this window the provider's session cache is unreliable: model
// memory was likely compacted and skill/doc/retrieval context (which is
// only injected on first invocation) is gone.
const MAX_AGE_MS = 30 * 60 * 1000;

const CONTINUE_PROMPT = `Continue your previous work. Finish any unfinished changes from the prior turn, then end with the same final summary contract you used before.`;

const RESUMABLE_KINDS = new Set(['run']);
function isResumableKind(kind: string): boolean {
  return RESUMABLE_KINDS.has(kind) || kind.startsWith('agent:');
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const sourceJob = getJob(jobId);
  if (!sourceJob) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  if (!isResumableKind(sourceJob.kind)) {
    return NextResponse.json(
      { detail: `kind '${sourceJob.kind}' is not resumable — continue is only supported for agent and run jobs` },
      { status: 400 },
    );
  }
  let sessionId: string | null = sourceJob.sessionId ?? null;
  if (!sessionId && sourceJob.logPath) {
    // Job died before the stream parser flushed session_id to the DB
    // (PM2 restart mid-stream is the common case). Fall back to reading
    // the tail of the log file.
    try {
      const { existsSync, openSync, fstatSync, readSync, closeSync } = await import('fs');
      if (existsSync(/*turbopackIgnore: true*/ sourceJob.logPath)) {
        const fd = openSync(/*turbopackIgnore: true*/ sourceJob.logPath, 'r');
        try {
          const size = fstatSync(fd).size;
          const len = Math.min(size, 8192);
          const buf = Buffer.allocUnsafe(len);
          readSync(fd, buf, 0, len, size - len);
          const { findSessionIdInLog } = await import('@/lib/jobs/auto-resume');
          sessionId = findSessionIdInLog(buf.toString('utf-8'));
        } finally {
          closeSync(fd);
        }
      }
    } catch {}
  }
  if (!sessionId) {
    return NextResponse.json(
      { detail: 'source job has no sessionId — nothing to --resume' },
      { status: 400 },
    );
  }
  if (sourceJob.finishedAt === null) {
    return NextResponse.json(
      { detail: 'source job is still running — stop it before continuing' },
      { status: 409 },
    );
  }
  const ageMs = Date.now() - sourceJob.finishedAt * 1000;
  if (ageMs > MAX_AGE_MS) {
    return NextResponse.json(
      {
        detail: `source job finished ${Math.round(ageMs / 60000)}m ago — beyond the ${Math.round(MAX_AGE_MS / 60000)}m cache window for safe --resume`,
      },
      { status: 410 },
    );
  }

  const projectName = sourceJob.project;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${projectName}' not found` }, { status: 404 });
  }

  const blocking = await findBlockingRunningJob(projectName);
  if (blocking) {
    return NextResponse.json(
      {
        detail: `Job '${blocking.kind}' is already running for ${projectName} (job ${blocking.id})`,
        blocking_job_id: blocking.id,
      },
      { status: 409 },
    );
  }

  const gate = await checkCliStartGate('continue a job', { preferred: sourceJob.provider ?? null });
  if (!gate.ok) return NextResponse.json({ detail: gate.detail }, { status: gate.status });
  const provider = gate.provider;

  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const model = sourceJob.model || resolveCliDefaultModel(provider, settings);

  const { logDir } = getImproveConfig();
  mkdirSync(logDir, { recursive: true });

  // Continuation prompt is short on purpose — the model already has the
  // working context in the resumed session. withBasePrompt prepends the
  // `base_prompt` setting (e.g. "never ask clarifying questions") so the
  // resumed agent keeps the same operating directives.
  const prompt = withBasePrompt(CONTINUE_PROMPT, { projectPath: projPath, provider });

  const job = createJob(projectName, sourceJob.kind, 0, '', undefined, undefined, undefined, undefined, undefined, undefined, sourceJob.id);
  job.provider = provider;
  job.sessionId = sessionId;
  job.logPath = join(logDir, `${job.id}.log`);

  try {
    const pid = await startJobInProcess(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag()} --resume ${sessionId}`,
      prompt,
      projPath,
      { env: cliEnv },
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return NextResponse.json(
      { detail: `Failed to start continuation: ${errMsg(e)}` },
      { status: 500 },
    );
  }

  updateJob(job);
  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    resumed_session_id: sessionId,
    resumed_from: sourceJob.id,
  });
}
