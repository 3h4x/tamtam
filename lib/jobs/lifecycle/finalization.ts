import type { JobData } from '@/lib/jobs/types';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { updateJob } from '@/lib/jobs/storage';
import { markDone } from './mark-done';

export async function finalizeReleaseJob(release: JobData, exitCode: number): Promise<void> {
  if (release.finishedAt !== null) return;
  try {
    if (release.logPath) {
      appendRedactedFileSync(release.logPath, `\n# release finished — exit ${exitCode} — ${new Date().toISOString()}\n`);
    }
  } catch {}
  await markDone(release, exitCode);
  // Release the pipeline lock
  try {
    const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
    await releaseLock(release.project, release.id);
  } catch {}
}

export async function finalizeAbortedRelease(release: JobData): Promise<void> {
  if (release.abortedAt == null) {
    release.abortedAt = Date.now() / 1000;
    updateJob(release);
  }
  await finalizeReleaseJob(release, -3);
}

