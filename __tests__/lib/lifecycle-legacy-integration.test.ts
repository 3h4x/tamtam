import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/types';
import { getTestDb, insertJobsAndCache, makeJobRow, markDone, mocks, ndjsonText, resetTestState } from './lifecycle-fixtures';

// ─── concurrent step finalization guard ──────────────────────────────────────

// Release-linked chain blocks short-circuit at lifecycle.ts ~line 488 — the
// Vercel Workflow orchestrator owns chaining + finalization for any job
// with a releaseId. The semantics these tests cover (concurrent-step
// finalization, verdict retry rescue, reviewIsStuck convergence guard,
// fix→review caps, push fix cap notifications) are now tested in:
//   __tests__/lib/workflows/release-orchestrator.test.ts
//   __tests__/lib/workflows/guards/review-convergence.test.ts
//   __tests__/lib/workflows/guards/iteration-caps.test.ts
// Skipped (not deleted) so the legacy semantics stay reviewable as long as
// the standalone-job code path remains.
describe.skip('concurrent step finalization guard', () => {
  function makeInMemoryJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind,
      prompt: null,
      pid: 0,
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
  });

  it('does NOT finalize the release when another pipeline step is still running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release and a running test step (sibling, still running)
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-1', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({ id: 'test-1', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: null }),
    ]);

    // A review job finishes with exit 1 (crash/failure — no chaining path fires)
    const reviewJob = makeInMemoryJob('review-1', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-1',
    });

    await markDone(reviewJob, 1);

    // Release should NOT be finalized — the guard defers to the still-running test
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-1'))).at(0);
    expect(relRow?.finishedAt).toBeNull();
  });

  it('finalizes the release when no other step is running', async () => {
    const now = Date.now() / 1000;
    // Insert an active release with NO running siblings
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-2', project: 'proj', kind: 'release', startedAt: now - 120 }),
    ]);

    const reviewJob = makeInMemoryJob('review-2', 'review', {
      startedAt: now - 30,
      releaseId: 'rel-2',
    });

    await markDone(reviewJob, 1);

    // Release SHOULD be finalized since no sibling is running
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-2'))).at(0);
    expect(relRow?.finishedAt).not.toBeNull();
  });

  it('does not count a finished sibling step as "still running"', async () => {
    const now = Date.now() / 1000;
    // Test step is already finished
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'rel-3', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({ id: 'test-3', project: 'proj', kind: 'test', startedAt: now - 60, finishedAt: now - 30, exitCode: 0 }),
    ]);

    const reviewJob = makeInMemoryJob('review-3', 'review', {
      startedAt: now - 25,
      releaseId: 'rel-3',
    });

    await markDone(reviewJob, 1);

    // Finished sibling should NOT block finalization
    const relRow = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, 'rel-3'))).at(0);
    expect(relRow?.finishedAt).not.toBeNull();
  });
});

// ─── verdict retry rescue (lifecycle integration) ──────────────────────────

// Skipped: verdict-retry rescue runs inside the legacy review block which
// is now release-linked-short-circuited. The rescue path itself
// (lib/jobs/verdict-retry.ts) is still alive for standalone reviews and
// for the orchestrator's getVerdict() call — coverage exists in
// __tests__/lib/verdict-retry.test.ts. The lifecycle integration tested
// here is no longer reachable on release-linked jobs.
describe.skip('verdict retry rescue', () => {
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string | null, overrides: Partial<JobData> = {}): JobData {
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
      releaseId: 'release-retry',
      provider: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-retry-test-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0,
      fix_ci_retry_window_seconds: 120,
      fix_ci_fast_crash_ms: 5000,
      review_retry_on_parse_failure: true,
    });
    mocks.startProjectCommit.mockResolvedValue({ ok: true, jobId: 'commit-1' });
    mocks.startMarkDod.mockResolvedValue({ ok: false });

    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'release-retry', project: 'proj', kind: 'release', startedAt: now - 120 })]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls retryVerdictWithClaude when the review log has no parseable verdict', async () => {
    const logPath = join(tempDir, 'no-verdict.log');
    writeFileSync(logPath, 'The code looks fine overall. No major issues spotted.\n');

    await markDone(makeReviewJob('rev-no-verdict', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
  });

  it('passes the source review provider into parse-retry for non-Claude reviews', async () => {
    const logPath = join(tempDir, 'no-verdict-codex.log');
    writeFileSync(logPath, 'Review text without a formal verdict line.\n');

    await markDone(makeReviewJob('rev-no-verdict-codex', logPath, { provider: 'codex' }), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rev-no-verdict-codex',
      provider: 'codex',
    }));
  });

  it('uses the rescued verdict from retry — LGTM → no fix started', async () => {
    mocks.retryVerdictWithClaude.mockResolvedValue('LGTM');
    const logPath = join(tempDir, 'no-verdict-lgtm.log');
    writeFileSync(logPath, 'Everything looks good, tests pass.\n');

    await markDone(makeReviewJob('rev-rescued-lgtm', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('defaults to NEEDS ATTENTION when retry also returns null → fix is started', async () => {
    mocks.retryVerdictWithClaude.mockResolvedValue(null);
    const logPath = join(tempDir, 'no-verdict-null.log');
    writeFileSync(logPath, 'Some concerns here but no verdict emitted.\n');

    await markDone(makeReviewJob('rev-retry-null', logPath), 0);

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('rev-retry-null');
  });

  it('swallows retryVerdictWithClaude throws — defaults to NEEDS ATTENTION and starts fix', async () => {
    mocks.retryVerdictWithClaude.mockRejectedValue(new Error('spawn ENOENT'));
    const logPath = join(tempDir, 'no-verdict-throw.log');
    writeFileSync(logPath, 'Review text that has no verdict line.\n');

    // Must not throw even though retryVerdictWithClaude rejects
    await expect(markDone(makeReviewJob('rev-retry-throw', logPath), 0)).resolves.not.toThrow();

    expect(mocks.retryVerdictWithClaude).toHaveBeenCalledOnce();
    // After swallowed throw, rawVerdict is null → defaults to NEEDS ATTENTION → fix started
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('rev-retry-throw');
  });
});

// ─── incremental review ref guard ────────────────────────────────────────────

// Skipped: the markReviewed call lives inside the release-linked review
// block which now short-circuits early. setReviewedRef itself is exercised
// via the orchestrator's review-phase + start-review (see start-review.ts:
// it sets the ref on its own non-pipeline path).
describe.skip('setReviewedRef incremental_review_enabled guard', () => {
  let tempDir: string;

  function makeReviewJob(id: string, logPath: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind: 'review', prompt: null, pid: 0, logPath,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      releaseId: 'rel-inc', provider: null,
      ...overrides,
    };
  }

  function setIncremental(incrementalEnabled: boolean): void {
    mocks.getSettings.mockReturnValue({
      fix_ci_max_retries: 0, fix_ci_retry_window_seconds: 120, fix_ci_fast_crash_ms: 5000,
      incremental_review_enabled: incrementalEnabled,
    });
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-inc-ref-'));
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.getCurrentBranch.mockResolvedValue('main');

    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'rel-inc', project: 'proj', kind: 'release', startedAt: now - 60 })]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT write reviewed ref when incremental_review_enabled is false', async () => {
    setIncremental(false);
    const logPath = join(tempDir, 'lgtm-off.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('rev-off', logPath), 0);

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
  });

  it('writes reviewed ref when incremental_review_enabled is true and project path resolves', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'lgtm-on.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(makeReviewJob('rev-on', logPath), 0);

    expect(mocks.setReviewedRef).toHaveBeenCalledWith('/path/to/proj', 'main');
  });

  it('does NOT write reviewed ref for LGTM PR reviews', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'lgtm-pr.log');
    writeFileSync(logPath, 'Findings: none\nVerdict: LGTM\n');

    await markDone(
      makeReviewJob('rev-pr', logPath, {
        contextMeta: JSON.stringify({ sourceType: 'pr_review', prNumber: 7 }),
      }),
      0
    );

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
  });

  it('does NOT write reviewed ref for non-LGTM verdicts', async () => {
    setIncremental(true);
    const logPath = join(tempDir, 'needs-attn.log');
    writeFileSync(logPath, 'Findings:\n- Finding ID: x\n  Severity: low\nVerdict: NEEDS ATTENTION\n');

    await markDone(makeReviewJob('rev-na', logPath), 0);

    expect(mocks.setReviewedRef).not.toHaveBeenCalled();
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

// ─── auto-mark seen on completion ────────────────────────────────────────────

describe('auto-mark seen on completion', () => {
  function makeInMemoryJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  async function runMarkDone(job: JobData, exitCode: number): Promise<boolean> {
    await markDone(job, exitCode);
    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id))).at(0);
    return !!row?.seen;
  }

  it('auto-marks a successful pipeline child seen (commit / push / test)', async () => {
    for (const kind of ['commit', 'push', 'test', 'mark-dod']) {
      // Each iteration starts from a clean state so previous DB rows don't
      // leak into subsequent assertions.
      await resetTestState();
      const seen = await runMarkDone(makeInMemoryJob(`${kind}-ok`, kind), 0);
      expect(seen, `${kind} exit-0 should be auto-seen`).toBe(true);
    }
  });

  it('does NOT auto-mark a failed pipeline child seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('test-fail', 'test'), 1);
    expect(seen).toBe(false);
  });

  it('does not spawn a push-fix job for remote race failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-remote-race-'));
    try {
      const logPath = join(tempDir, 'push.log');
      writeFileSync(logPath, "remote: error: cannot lock ref 'refs/heads/main': is at aaa but expected bbb\n");
      mocks.isRemoteRaceRejection.mockReturnValue(true);

      const seen = await runMarkDone(makeInMemoryJob('push-remote-race', 'push', { logPath }), 1);

      expect(seen).toBe(false);
      expect(mocks.isRemoteRaceRejection).toHaveBeenCalled();
      expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT auto-mark a release meta-job seen even on success', async () => {
    const seen = await runMarkDone(makeInMemoryJob('rel-ok', 'release'), 0);
    expect(seen).toBe(false);
  });

  it('does NOT auto-mark interactive `run` jobs seen', async () => {
    const seen = await runMarkDone(makeInMemoryJob('term-ok', 'run'), 0);
    expect(seen).toBe(false);
  });

  it('auto-marks an LGTM review seen but leaves NEEDS ATTENTION unseen', async () => {
    const lgtmLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'lgtm.log');
    writeFileSync(lgtmLog, 'Findings: none\nVerdict: LGTM\n');
    const seenLgtm = await runMarkDone(makeInMemoryJob('rev-lgtm', 'review', { logPath: lgtmLog }), 0);
    expect(seenLgtm).toBe(true);

    await resetTestState();
    const naLog = join(mkdtempSync(join(tmpdir(), 'amark-')), 'na.log');
    writeFileSync(naLog, 'Findings:\n- Finding ID: x\nVerdict: NEEDS ATTENTION\n');
    const seenNa = await runMarkDone(makeInMemoryJob('rev-na', 'review', { logPath: naLog }), 0);
    expect(seenNa).toBe(false);
  });

  it('auto-marks a no-op agent run (empty modifiedFiles) seen but keeps actionable runs unseen', async () => {
    const seenNoop = await runMarkDone(
      makeInMemoryJob('agent-noop', 'agent:improve', { modifiedFiles: '[]' }),
      0,
    );
    expect(seenNoop).toBe(true);

    await resetTestState();
    const seenActionable = await runMarkDone(
      makeInMemoryJob('agent-act', 'agent:improve', { modifiedFiles: '[{"path":"a.ts"}]' }),
      0,
    );
    expect(seenActionable).toBe(false);
  });

  it('keeps an agent run unseen when report extraction fails and modifiedFiles is missing', async () => {
    mocks.finalizeAgentRunReport.mockRejectedValueOnce(new Error('git status failed'));
    const seen = await runMarkDone(
      makeInMemoryJob('agent-report-fail', 'agent:improve', { modifiedFiles: null }),
      0,
    );
    expect(seen).toBe(false);
  });

  it('persists agent report fields before emitting the durable completion event', async () => {
    mocks.finalizeAgentRunReport.mockImplementationOnce(async (job: JobData) => {
      expect(job.finishedAt).not.toBeNull();
      job.workSummary = 'Changed the release gate.';
      job.modifiedFiles = JSON.stringify([{ path: 'lib/jobs/lifecycle.ts', status: 'M' }]);
      job.linesAdded = 12;
      job.linesRemoved = 3;
    });

    const job = makeInMemoryJob('agent-report-fields', 'agent:improve');
    await markDone(job, 0);

    const row = (await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id))).at(0);
    expect(row).toMatchObject({
      finishedAt: expect.any(Number),
      workSummary: 'Changed the release gate.',
      modifiedFiles: JSON.stringify([{ path: 'lib/jobs/lifecycle.ts', status: 'M' }]),
      linesAdded: 12,
      linesRemoved: 3,
      runScore: 91,
    });

    const event = (await getTestDb().select().from(schema.jobCompletionEvents).where(eq(schema.jobCompletionEvents.jobId, job.id))).at(0);
    expect(event).toMatchObject({
      jobId: job.id,
      kind: 'agent:improve',
      exitCode: 0,
      project: 'proj',
    });
  });
});

// Skipped: push-fix cap is now in iteration-caps.ts (special-case for
// fix-from-push) and exercised in iteration-caps.test.ts.
describe.skip('push fix cap notifications', () => {
  let tempDir: string;

  function makePushJob(id: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id,
      project: 'proj',
      kind: 'push',
      prompt: null,
      pid: 0,
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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-push-fix-cap-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
      autoPrMergeEnabled: false,
    });
    mocks.isHookRejection.mockReturnValue(true);
    mocks.isTestFailureRejection.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits fix_loop_exhausted when push hook retries hit the cap (counts fix jobs whose parent is a push)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release.log');
    const pushLog = join(tempDir, 'push.log');
    writeFileSync(releaseLog, '# release start\n');
    writeFileSync(pushLog, 'husky - pre-push hook exited with code 1\n');

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({
        id: 'release-push-fix-cap',
        project: 'proj',
        kind: 'release',
        logPath: releaseLog,
        startedAt: now - 300,
      }),
      // Two prior failed pushes; each has a fix-from-push that counts toward the cap.
      makeJobRow({
        id: 'push-old-1',
        project: 'proj',
        kind: 'push',
        startedAt: now - 200,
        finishedAt: now - 190,
        exitCode: 1,
      }),
      makeJobRow({
        id: 'fix-old-1',
        project: 'proj',
        kind: 'fix',
        parentJobId: 'push-old-1',
        startedAt: now - 120,
        finishedAt: now - 110,
        exitCode: 0,
      }),
      makeJobRow({
        id: 'push-old-2',
        project: 'proj',
        kind: 'push',
        startedAt: now - 100,
        finishedAt: now - 95,
        exitCode: 1,
      }),
      makeJobRow({
        id: 'fix-old-2',
        project: 'proj',
        kind: 'fix',
        parentJobId: 'push-old-2',
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const pushJob = makePushJob('push-cap-hit', {
      logPath: pushLog,
      releaseId: 'release-push-fix-cap',
      startedAt: now - 10,
    });

    await markDone(pushJob, 1);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      event: 'fix_loop_exhausted',
      project: 'proj',
      job_id: 'push-cap-hit',
      status: 'failed',
    }));

    const releaseRow = (await getTestDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, 'release-push-fix-cap'))).at(0);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    expect(releaseRow?.contextMeta).toContain('"releaseStopReason":"push fix cap reached for proj');
    expect(readFileSync(releaseLog, 'utf8')).toContain('push fix cap reached for proj');
  });

});
