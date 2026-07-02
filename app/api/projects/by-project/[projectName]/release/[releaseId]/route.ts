import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { buildPipelineSteps, jobRunStatus } from '@/lib/jobs/job-trace';
import { exec } from '@/lib/shared/shell';
import { resolveProjectPath } from '@/lib/shared/project-data';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectName: string; releaseId: string }> },
): Promise<NextResponse> {
  const { projectName, releaseId } = await params;

  const all = listJobs();

  // The release meta-job
  const releaseJob = all.find(
    (j) => j.id === releaseId && j.project === projectName && j.kind === 'release',
  );
  if (!releaseJob) {
    return NextResponse.json({ error: 'release not found' }, { status: 404 });
  }

  // All pipeline step jobs that share this releaseId (shared builder — same
  // verdict + log-excerpt logic the history detail drawer uses).
  const steps = buildPipelineSteps(all, projectName, releaseId);

  // Resolve branch at release start (best-effort)
  let branch: string | null = null;
  const projPath = resolveProjectPath(projectName);
  if (projPath) {
    try {
      const r = await exec('git', ['-C', projPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: 3000,
      });
      if (r.exitCode === 0) branch = r.stdout.trim();
    } catch {}
  }

  // Surface the triggering job (parent) so the UI can render
  // "← agent migration" / "← terminal run" alongside the release header.
  const triggerJob = releaseJob.parentJobId
    ? all.find((j) => j.id === releaseJob.parentJobId) ?? null
    : null;
  const trigger = triggerJob
    ? {
        job_id: triggerJob.id,
        kind: triggerJob.kind,
        label: triggerJob.kind.startsWith('agent:')
          ? `agent ${triggerJob.kind.replace(/^agent:/, '')}`
          : triggerJob.kind === 'run'
            ? 'terminal run'
            : triggerJob.kind,
        prompt: triggerJob.userPrompt ?? triggerJob.prompt ?? null,
        started_at: triggerJob.startedAt,
        finished_at: triggerJob.finishedAt ?? null,
        exit_code: triggerJob.exitCode ?? null,
      }
    : null;

  return NextResponse.json({
    release_id: releaseId,
    project: projectName,
    branch,
    status: jobRunStatus(releaseJob),
    started_at: releaseJob.startedAt,
    finished_at: releaseJob.finishedAt ?? null,
    exit_code: releaseJob.exitCode ?? null,
    trigger,
    steps,
  });
}
