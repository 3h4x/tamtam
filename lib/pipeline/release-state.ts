import { exec } from '@/lib/shared/shell';
import { getVerdict, listJobs } from '@/lib/jobs/job-storage';
import { isReviewed } from '@/lib/git/git-utils';
import type { JobData } from '@/lib/jobs/types';

function isPrReviewJob(job: Pick<JobData, 'contextMeta'>): boolean {
  if (!job.contextMeta) return false;
  try {
    const meta = JSON.parse(job.contextMeta) as { sourceType?: unknown };
    return meta.sourceType === 'pr_review';
  } catch {
    return false;
  }
}

export async function hasFreshLgtm(projectName: string, projPath: string): Promise<boolean> {
  try {
    let latestReview: JobData | null = null;
    for (const job of listJobs()) {
      if (
        job.project !== projectName ||
        job.kind !== 'review' ||
        job.finishedAt === null ||
        job.exitCode !== 0 ||
        isPrReviewJob(job)
      ) {
        continue;
      }
      if (!latestReview || job.finishedAt > (latestReview.finishedAt ?? 0)) {
        latestReview = job;
      }
    }
    if (!latestReview) return false;
    if (getVerdict(latestReview) !== 'LGTM') return false;
    return await isReviewed(projectName, projPath);
  } catch {
    return false;
  }
}

export async function hasLocalCommitsAhead(projPath: string): Promise<boolean> {
  // Primary: compare against the configured upstream tracking branch.
  try {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    if (aheadR.exitCode === 0) {
      const ahead = parseInt(aheadR.stdout.trim(), 10);
      return Number.isFinite(ahead) && ahead > 0;
    }
    // Non-zero exit usually means "no upstream configured for branch X".
    // Fall through to the default-branch comparison so an issue branch
    // that hasn't been pushed yet still counts as having work to ship.
  } catch {
    // ignore — try the default-branch fallback
  }
  // Fallback: when the working branch has no upstream (typical for a
  // freshly created `fix/issue-N-...` branch), compare against the repo's
  // default branch. `start-push` will run `--set-upstream` on the actual
  // push, so the release should proceed instead of returning a misleading
  // "Nothing to release".
  try {
    const { getDefaultBranchSync } = await import('@/lib/git/git-branch');
    const defaultBranch = getDefaultBranchSync(projPath);
    if (!defaultBranch) return false;
    const aheadR = await exec(
      'git',
      ['-C', projPath, 'rev-list', '--count', `${defaultBranch}..HEAD`],
      { timeout: 5000 },
    );
    if (aheadR.exitCode !== 0) return false;
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    return Number.isFinite(ahead) && ahead > 0;
  } catch {
    return false;
  }
}
