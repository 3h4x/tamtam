import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/types';
import { markDone, mocks, resetTestState } from './lifecycle-fixtures';

// A per-PR "Review" click runs a read-only PR-diff review stamped
// contextMeta.sourceType === 'pr_review'. It must NOT enter the release
// commit/push/fix chaining (that operates on the working copy, which is on the
// default branch — not the PR branch), even when the project has
// auto_push_enabled. Regression: completion-hooks used to run startProjectCommit
// for a pr_review LGTM, producing a phantom no-op commit/push on the wrong branch.
describe('PR-diff review does not trigger release commit/push/fix chaining', () => {
  let tempDir: string;

  function makePrReviewJob(logPath: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id: 'pr-review-job',
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
      contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 1, headRef: 'feature', baseRef: 'main' }),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-pr-review-merge-'));
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    // auto-push ON is the exact config under which the bug fired.
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
      autoPrMergeEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      incremental_review_enabled: false,
      review_retry_on_parse_failure: false,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not commit/push/fix after a PR review returns LGTM even when auto_push is enabled', async () => {
    const logPath = join(tempDir, 'pr-lgtm.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makePrReviewJob(logPath), 0);

    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('does not start a fix after a PR review returns NEEDS ATTENTION even when auto_push is enabled', async () => {
    const logPath = join(tempDir, 'pr-needs.log');
    writeFileSync(logPath, 'Findings:\n- something\nVerdict: NEEDS ATTENTION\n');

    await markDone(makePrReviewJob(logPath), 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
  });

  it('hands a completed PR review to the auto-merge decision', async () => {
    const logPath = join(tempDir, 'pr-lgtm-handoff.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');
    const job = makePrReviewJob(logPath);

    await markDone(job, 0);

    expect(mocks.maybeAutoMergeAfterPrReview).toHaveBeenCalledOnce();
    expect(mocks.maybeAutoMergeAfterPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pr-review-job' }),
    );
  });

  it('does not invoke the auto-merge decision for a working-tree (non-PR) review', async () => {
    const logPath = join(tempDir, 'wt-lgtm.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');
    const job = makePrReviewJob(logPath, { contextMeta: null });

    await markDone(job, 0);

    expect(mocks.maybeAutoMergeAfterPrReview).not.toHaveBeenCalled();
  });
});
