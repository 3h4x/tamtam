import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getJob, createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess } from '@/lib/jobs/spawn-claude-detached';
import { getPermissionModeFlag, getSettings, withBasePrompt } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { buildResumePrompt } from '@/lib/jobs/auto-resume';
import { prepareBrokerRun } from '@/lib/browser-broker/prepare-run';

// How recently the source job must have finished to allow a --resume.
// Beyond this window the provider's session cache is unreliable: model
// memory was likely compacted and skill/doc/retrieval context (which is
// only injected on first invocation) is gone.
const MAX_AGE_MS = 30 * 60 * 1000;

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
      const { openSync, fstatSync, readSync, closeSync } = await import('fs');
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
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  // Continuation prompt restates the agent identity, original task, and a
  // lost-context escape hatch. The CLI's --resume reloads the session from
  // the provider cache, but caches can be evicted or compacted, so the
  // body has to stand alone if context is lost. withBasePrompt prepends
  // the `base_prompt` setting so operating directives carry over.
  const prompt = withBasePrompt(buildResumePrompt(sourceJob), { projectPath: projPath, provider });

  const job = createJob(projectName, sourceJob.kind, 0, '', undefined, undefined, undefined, undefined, undefined, undefined, sourceJob.id);
  job.provider = provider;
  job.sessionId = sessionId;
  job.logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);

  let broker: { env: Record<string, string>; cleanup: () => void } | null = null;
  try {
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, projectName)).limit(1);
    const projectRow = rows[0] ?? null;
    broker = await prepareBrokerRun({
      jobId: job.id,
      projectOrigins: {
        qaUrl: projectRow?.qaUrl ?? null,
        devServerReadyUrl: projectRow?.devServerReadyUrl ?? null,
        website: projectRow?.website ?? null,
      },
      provider,
    });
  } catch (e) {
    console.warn(`[job-continue] broker prep failed for ${job.id}:`, e);
  }

  try {
    const pid = await startJobInProcess(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag()} --resume ${sessionId}`,
      prompt,
      projPath,
      {
        env: broker ? { ...cliEnv, ...broker.env } : cliEnv,
        cleanup: broker?.cleanup,
      },
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
