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
    const latestReview = listJobs()
      .filter(
        (j) =>
          j.project === projectName &&
          j.kind === 'review' &&
          j.finishedAt !== null &&
          j.exitCode === 0 &&
          !isPrReviewJob(j)
      )
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (!latestReview) return false;
    if (getVerdict(latestReview) !== 'LGTM') return false;
    return await isReviewed(projectName, projPath);
  } catch {
    return false;
  }
}

export async function hasLocalCommitsAhead(projPath: string): Promise<boolean> {
  try {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    return aheadR.exitCode === 0 && Number.isFinite(ahead) && ahead > 0;
  } catch {
    return false;
  }
}
