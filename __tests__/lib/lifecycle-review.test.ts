import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/types';
import { getTestDb, insertJobsAndCache, makeJobRow, markDone, mocks, resetTestState } from './lifecycle-fixtures';

describe('standalone review cap fallback', () => {
  function makeFixJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'fix',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({ fix_max_iterations: 1 });
  });

  it('re-runs host tests after a review-driven fix before re-reviewing', async () => {
    mocks.getSettings.mockReturnValue({ fix_max_iterations: 2 });
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'review-parent',
        project: 'proj',
        kind: 'review',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
        verdict: 'NEEDS ATTENTION',
      }),
    ]);

    const fixJob = makeFixJob('fix-from-review', {
      parentJobId: 'review-parent',
      startedAt: now - 30,
    });

    await markDone(fixJob, 0);

    expect(mocks.startProjectTest).toHaveBeenCalledOnce();
    expect(mocks.startProjectTest).toHaveBeenCalledWith('proj', { reviewRetest: true });
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
  });

  it('forces re-review after a review-driven re-test even when review is disabled', async () => {
    mocks.resolveProjectPath.mockReturnValue('/repo/project');
    mocks.exec.mockResolvedValue({ exitCode: 0, stdout: ' M file.ts\n', stderr: '' });
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
      reviewDisabled: true,
    });
    mocks.isReviewRetestJob.mockReturnValue(true);
    const now = Date.now() / 1000;
    const testJob: JobData = {
      id: 'review-retest',
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: now - 30,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      contextMeta: JSON.stringify({ pipelineReason: 'review-retest' }),
    };

    await markDone(testJob, 0);

    expect(mocks.startProjectReview).toHaveBeenCalledOnce();
    expect(mocks.startProjectReview).toHaveBeenCalledWith('proj');
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
  });

  it('falls back to re-review after a review-driven fix when no host test command is runnable', async () => {
    mocks.getSettings.mockReturnValue({ fix_max_iterations: 2 });
    mocks.hasRunnableTestCommand.mockResolvedValue(false);
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'review-parent',
        project: 'proj',
        kind: 'review',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
        verdict: 'NEEDS ATTENTION',
      }),
    ]);

    const fixJob = makeFixJob('fix-from-review-no-tests', {
      parentJobId: 'review-parent',
      startedAt: now - 30,
    });

    await markDone(fixJob, 0);

    expect(mocks.hasRunnableTestCommand).toHaveBeenCalledWith('proj');
    expect(mocks.startProjectTest).not.toHaveBeenCalled();
    expect(mocks.startProjectReview).toHaveBeenCalledOnce();
    expect(mocks.startProjectReview).toHaveBeenCalledWith('proj');
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
  });

  it('cites the newest standalone review when the review cap is exhausted', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'older-do-not-ship-review',
        project: 'proj',
        kind: 'review',
        startedAt: now - 180,
        finishedAt: now - 170,
        exitCode: 0,
        verdict: 'DO NOT SHIP',
      }),
      makeJobRow({
        id: 'newer-needs-attention-review',
        project: 'proj',
        kind: 'review',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
        verdict: 'NEEDS ATTENTION',
      }),
    ]);

    const fixJob = makeFixJob('standalone-cap-fix', {
      parentJobId: 'newer-needs-attention-review',
      startedAt: now - 30,
    });

    await markDone(fixJob, 0);

    expect(mocks.startProjectTest).not.toHaveBeenCalled();
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledOnce();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'newer-needs-attention-review' }),
    );
    expect(mocks.startProjectCommit).toHaveBeenCalledOnce();
  });
});

describe('review completion preserves the git index', () => {
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'review',
      prompt: null,
      pid: 0,
      logPath,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
      provider: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-index-'));
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0,
      fix_ci_retry_window_seconds: 120,
      fix_ci_fast_crash_ms: 5000,
      incremental_review_enabled: false,
      review_retry_on_parse_failure: false,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not stage files after a successful standalone review', async () => {
    const logPath = join(tempDir, 'standalone.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('review-standalone', logPath), 0);

    expect(mocks.markReviewed).toHaveBeenCalledWith('proj', '/path/to/proj');
    expect(mocks.exec.mock.calls.some((call: unknown[]) => call[0] === 'git' && (call[1] as string[])[2] === 'add')).toBe(false);
  });

  it('does not stage files after a successful PR review', async () => {
    const logPath = join(tempDir, 'pr-review.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(
      makeReviewJob('review-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(mocks.markReviewed).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some((call: unknown[]) => call[0] === 'git' && (call[1] as string[])[2] === 'add')).toBe(false);
  });
});
