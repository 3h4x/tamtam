import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

// Mocked collaborators for maybeAutoMergeAfterPrReview. Hoisted so the
// vi.mock factories (which are lifted above these declarations) can close over
// the same fn instances.
const {
  getVerdictMock,
  getProjectPipelineConfigMock,
  resolveProjectPathMock,
  getPrAuthorLoginMock,
  isUserTrustedMock,
  launchPrWaitMock,
  resolvePrTargetMock,
} = vi.hoisted(() => ({
  getVerdictMock: vi.fn(),
  getProjectPipelineConfigMock: vi.fn(),
  resolveProjectPathMock: vi.fn(),
  getPrAuthorLoginMock: vi.fn(),
  isUserTrustedMock: vi.fn(),
  launchPrWaitMock: vi.fn(),
  resolvePrTargetMock: vi.fn(),
}));

vi.mock('@/lib/jobs/verdict', () => ({ getVerdict: getVerdictMock }));
vi.mock('@/lib/jobs/lifecycle-helpers', () => ({ getProjectPipelineConfig: getProjectPipelineConfigMock }));
vi.mock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
vi.mock('@/lib/github/pr-author', () => ({ getPrAuthorLogin: getPrAuthorLoginMock }));
vi.mock('@/lib/shared/untrusted', () => ({ isUserTrusted: isUserTrustedMock }));
vi.mock('@/lib/pipeline/start-pr-wait', () => ({
  launchPrWait: launchPrWaitMock,
  resolvePrTarget: resolvePrTargetMock,
}));

import { maybeAutoMergeAfterPrReview } from '@/lib/pipeline/pr-review-merge';

function makePrReviewJob(overrides: Partial<JobData> = {}): JobData {
  const now = Date.now() / 1000;
  return {
    id: 'pr-review-1',
    project: 'proj',
    kind: 'review',
    prompt: null,
    pid: 0,
    logPath: '/tmp/x.log',
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 42, headRef: 'feature', baseRef: 'main' }),
    ...overrides,
  } as JobData;
}

describe('maybeAutoMergeAfterPrReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerdictMock.mockReturnValue('LGTM');
    getProjectPipelineConfigMock.mockResolvedValue({ autoPrMergeEnabled: true, autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false });
    resolveProjectPathMock.mockReturnValue('/repo/proj');
    resolvePrTargetMock.mockResolvedValue({ prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/42' });
    getPrAuthorLoginMock.mockResolvedValue('trusted-user');
    isUserTrustedMock.mockReturnValue(true);
    launchPrWaitMock.mockReturnValue({ jobId: 'pr-wait-42' });
  });

  it('launches pr-wait on LGTM when auto-merge is enabled and the PR author is trusted', async () => {
    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).toHaveBeenCalledWith('proj', 42, 'owner/repo', 'https://github.com/owner/repo/pull/42');
    expect(result).toEqual({ launched: true, jobId: 'pr-wait-42' });
  });

  it('does not merge when the review verdict is not LGTM', async () => {
    getVerdictMock.mockReturnValue('NEEDS ATTENTION');

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(result.launched).toBe(false);
    expect(result.reason).toBe('verdict-not-lgtm');
  });

  it('does not merge when auto_pr_merge is disabled for the project', async () => {
    getProjectPipelineConfigMock.mockResolvedValue({ autoPrMergeEnabled: false, autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false });

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('auto-merge-disabled');
  });

  it('does not merge an untrusted-author PR (fail closed)', async () => {
    isUserTrustedMock.mockReturnValue(false);

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('author-untrusted');
  });

  it('does not merge when the PR author cannot be resolved (fail closed)', async () => {
    getPrAuthorLoginMock.mockResolvedValue(null);

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(isUserTrustedMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('author-untrusted');
  });

  it('is a no-op for a non-PR review job', async () => {
    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob({ contextMeta: null }));

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('not-pr-review');
  });

  it('bails when the PR target cannot be resolved', async () => {
    resolvePrTargetMock.mockResolvedValue({ error: 'gh pr view failed' });

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(launchPrWaitMock).not.toHaveBeenCalled();
    expect(result.reason).toBe('resolve-failed');
  });

  it('reports the pr-wait launch error instead of throwing', async () => {
    launchPrWaitMock.mockReturnValue({ error: 'jobs paused' });

    const result = await maybeAutoMergeAfterPrReview(makePrReviewJob());

    expect(result.launched).toBe(false);
    expect(result.reason).toBe('jobs paused');
  });
});
