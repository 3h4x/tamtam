import { NextRequest, NextResponse } from 'next/server';
import { listJobs, getVerdict, readLog } from '@/lib/jobs/job-storage';
import { exec } from '@/lib/shared/shell';
import { resolveProjectPath } from '@/lib/shared/project-data';

const PIPELINE_STEP_KINDS = ['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'pr-wait', 'mark-dod'];

function jobStatus(job: { abortedAt?: number | null; finishedAt: number | null }): 'running' | 'done' | 'aborted' {
  if (job.abortedAt != null) return 'aborted';
  if (job.finishedAt != null) return 'done';
  return 'running';
}

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

  // All pipeline step jobs that share this releaseId
  const stepJobs = all
    .filter(
      (j) =>
        j.project === projectName &&
        j.releaseId === releaseId &&
        PIPELINE_STEP_KINDS.includes(j.kind),
    )
    .sort((a, b) => a.startedAt - b.startedAt);

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

  const steps = stepJobs.map((j) => {
    const verdict = getVerdict(j);
    const rawLog = readLog(j, 3000);
    // Last ~500 chars for the excerpt, stripped of NDJSON noise
    const excerpt = rawLog
      .replace(/\{"type":"[^"]+","subtype[^}]+\}/g, '')
      .trim()
      .slice(-500);

    return {
      job_id: j.id,
      kind: j.kind,
      status: jobStatus(j),
      exit_code: j.exitCode ?? null,
      started_at: j.startedAt,
      finished_at: j.finishedAt ?? null,
      duration_ms: j.durationMs ?? null,
      verdict: verdict ?? null,
      log_excerpt: excerpt,
    };
  });

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
    status: jobStatus(releaseJob),
    started_at: releaseJob.startedAt,
    finished_at: releaseJob.finishedAt ?? null,
    exit_code: releaseJob.exitCode ?? null,
    trigger,
    steps,
  });
}
