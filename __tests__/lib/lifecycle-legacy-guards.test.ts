import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { JobData } from '@/lib/jobs/types';
import { getTestDb, insertJobsAndCache, makeJobRow, markDone, mocks, ndjsonText, resetTestState } from './lifecycle-fixtures';

// ─── reviewIsStuck convergence guard (tested through markDone) ───────────────

// Skipped: ported to __tests__/lib/workflows/guards/review-convergence.test.ts
// + integration coverage in release-orchestrator.test.ts (see comment block
// at "concurrent step finalization guard" describe above for full pointer).
describe.skip('reviewIsStuck convergence guard', () => {
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
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-stuck-test-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true,
      autoCommitEnabled: false,
      releaseAfterRun: false,
      prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      fix_max_iterations: 3,
    });
    mocks.fileReviewExhaustionIssue.mockResolvedValue({ ok: true, issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT start a fix when the previous review in the same release has identical findings', async () => {
    const now = Date.now() / 1000;
    const findings = '## Findings\n- memory leak in cache.ts\n- missing error handler in api/route.ts\n';
    const prevLog = join(tempDir, 'prev-review.log');
    writeFileSync(prevLog, findings + 'Verdict: NEEDS ATTENTION\n');

    // Insert a previous review with same findings, already finished, in the same release
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    // Current review has identical findings — fix loop should be stopped
    const curLog = join(tempDir, 'cur-review.log');
    writeFileSync(curLog, findings + 'Verdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review', curLog, {
      releaseId: 'release-stuck',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('does NOT start a fix when structured finding IDs repeat with different wording', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-structured-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: missing server validation\nVerdict: DO NOT SHIP\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-structured-stuck', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-structured-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-structured-stuck',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-structured-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Finding ID: server-url-bypass\n  Root cause: alternate API still bypasses canonical parser\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-structured-review', curLog, {
      releaseId: 'release-structured-stuck',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
  });

  it('does NOT treat incidental id lines as structured finding IDs', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-incidental-id-review.log');
    writeFileSync(prevLog, ndjsonText('Findings:\n- Root cause: missing auth\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-incidental-id', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-incidental-id-review',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-incidental-id',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-incidental-id-review.log');
    writeFileSync(curLog, ndjsonText('Findings:\n- Root cause: missing cache invalidation\n  id: shared-placeholder\nVerdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-incidental-id-review', curLog, {
      releaseId: 'release-incidental-id',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
  });

  it('stops before exhaustion fallback when repeated review findings stop convergence (DO NOT SHIP)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-stuck-final.log');
    writeFileSync(releaseLog, '# release\n');
    const findings = 'Findings:\n- Finding ID: duplicate-bypass\n  Root cause: duplicate canonicalization missing\n';
    const prevLog = join(tempDir, 'prev-review-final.log');
    writeFileSync(prevLog, ndjsonText(findings + 'Verdict: NEEDS ATTENTION\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-stuck-final', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review-final',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-stuck-final',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-review-final.log');
    writeFileSync(curLog, ndjsonText(findings + 'Verdict: DO NOT SHIP\n'));
    const curReview = makeReviewJob('cur-review-final', curLog, {
      releaseId: 'release-stuck-final',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });

  it('DOES start a fix when the previous review has different findings', async () => {
    const now = Date.now() / 1000;
    const prevLog = join(tempDir, 'prev-review2.log');
    writeFileSync(prevLog, ndjsonText('## Findings\n- old bug in foo.ts\nVerdict: NEEDS ATTENTION\n'));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-diff', project: 'proj', kind: 'release', startedAt: now - 120 }),
      makeJobRow({
        id: 'prev-review2',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-diff',
        logPath: prevLog,
        startedAt: now - 90,
        finishedAt: now - 80,
        exitCode: 0,
      }),
    ]);

    // Current review has different findings — fix should proceed
    const curLog = join(tempDir, 'cur-review2.log');
    writeFileSync(curLog, '## Findings\n- different bug in bar.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('cur-review2', curLog, {
      releaseId: 'release-diff',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review2');
  });

  it('stops before exhaustion fallback when prior fix claimed an ID fixed but review still flags it (DO NOT SHIP)', async () => {
    const now = Date.now() / 1000;
    const releaseLog = join(tempDir, 'release-contradict.log');
    writeFileSync(releaseLog, '# release\n');

    const fixLog = join(tempDir, 'fix-contradict.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      '  Status: fixed',
      '  Files changed: Store.swift',
    ].join('\n')));

    const prevReviewLog = join(tempDir, 'prev-review-contradict.log');
    writeFileSync(prevReviewLog, ndjsonText([
      'Findings:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      'Verdict: DO NOT SHIP',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-contradict', project: 'proj', kind: 'release', logPath: releaseLog, startedAt: now - 200 }),
      makeJobRow({
        id: 'prev-review-contradict',
        project: 'proj',
        kind: 'review',
        releaseId: 'release-contradict',
        logPath: prevReviewLog,
        startedAt: now - 180,
        finishedAt: now - 170,
        exitCode: 0,
      }),
      makeJobRow({
        id: 'fix-contradict',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-contradict',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-review-contradict.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: multiline-escaped-quotes-truncate-imported-values',
      '  Root cause: still bypasses canonical parser',
      'Verdict: DO NOT SHIP',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-contradict', curLog, {
      releaseId: 'release-contradict',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });

  it('does NOT treat fix claiming Status: not fixed as a contradiction', async () => {
    const now = Date.now() / 1000;
    const fixLog = join(tempDir, 'fix-honest.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: tricky-finding',
      '  Status: not fixed',
      '  Remaining risk: needs deeper refactor',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-honest', project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({
        id: 'fix-honest',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-honest',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-review-honest.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: tricky-finding',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-honest', curLog, {
      releaseId: 'release-honest',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review-honest');
  });

  it('DOES start a fix when fix claimed a different ID than the review now flags', async () => {
    const now = Date.now() / 1000;
    const fixLog = join(tempDir, 'fix-different.log');
    writeFileSync(fixLog, ndjsonText([
      'Fix checklist:',
      '- Finding ID: original-finding',
      '  Status: fixed',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'release-different', project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({
        id: 'fix-different',
        project: 'proj',
        kind: 'fix',
        releaseId: 'release-different',
        logPath: fixLog,
        startedAt: now - 150,
        finishedAt: now - 100,
        exitCode: 0,
      }),
    ]);

    const curLog = join(tempDir, 'cur-review-different.log');
    writeFileSync(curLog, ndjsonText([
      'Findings:',
      '- Finding ID: brand-new-finding',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')));
    const curReview = makeReviewJob('cur-review-different', curLog, {
      releaseId: 'release-different',
      startedAt: now - 60,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('cur-review-different');
  });

  it('starts a fix on the first review in a release (no previous to compare against)', async () => {
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: 'release-first', project: 'proj', kind: 'release', startedAt: now - 60 })]);

    const curLog = join(tempDir, 'first-review.log');
    writeFileSync(curLog, '## Findings\n- some issue in baz.ts\nVerdict: NEEDS ATTENTION\n');
    const curReview = makeReviewJob('first-review', curLog, {
      releaseId: 'release-first',
      startedAt: now - 30,
    });

    await markDone(curReview, 0);

    expect(mocks.startFixFromJob).toHaveBeenCalledWith('first-review');
  });
});

// ─── verification cap (counts reviews/tests, not fixes) ──────────────────────

// Skipped: ported to __tests__/lib/workflows/guards/iteration-caps.test.ts
// (review-cap branch + integration in release-orchestrator.test.ts).
describe.skip('fix→review review-count cap', () => {
  let tempDir: string;

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
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-review-cap-'));
    mocks.getProjectTestConfig.mockReturnValue({
      autoPushEnabled: true, autoCommitEnabled: false, releaseAfterRun: false, prWorkflowEnabled: false,
    });
    mocks.getSettings.mockReturnValue({
      fix_max_iterations: 3,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips review #(MAX+1) when MAX reviews have already run, even with different findings each time', async () => {
    // Default MAX_STEP_ITERATIONS = 3. Insert 3 prior reviews with DISTINCT
    // findings (so reviewIsStuck and fixContradictsReview both return false).
    // The new cap must still trigger and skip the 4th review.
    const now = Date.now() / 1000;
    const releaseId = 'release-scope-creep';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }),
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }),
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }),
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }),
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }),
    ]);

    // The current fix's parent is r3 (a review) — fromTestFailure is false,
    // so we hit the fix→review branch where the cap should bite.
    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    // fix_loop_exhausted should fire as the release-stop notification.
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still chains to review when fewer than MAX reviews have run', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-under-cap';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const f1 = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });
    await markDone(f1, 0);

    expect(mocks.startProjectReview).toHaveBeenCalledOnce();
    expect(mocks.startProjectReview).toHaveBeenCalledWith('proj');
  });

  it('ignores unfinished sibling reviews when checking the release review cap', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-under-cap-with-running-review';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
      makeJobRow({ id: 'r2-running', project: 'proj', kind: 'review', releaseId, startedAt: now - 30, finishedAt: null, exitCode: null }),
    ]);

    const f1 = makeFixJob('f1-running-sibling', { releaseId, parentJobId: 'r1', startedAt: now - 20 });
    await markDone(f1, 0);

    expect(mocks.startProjectReview).toHaveBeenCalledOnce();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
  });

  it('stops before exhaustion fallback when the capped review is DO NOT SHIP', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-cap-do-not-ship';
    const reviewLog = join(tempDir, 'r3-review.log');
    writeFileSync(reviewLog, ndjsonText([
      'Findings:',
      '- Finding ID: auth-bypass',
      'Verdict: DO NOT SHIP',
    ].join('\n')));

    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 600 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 500, finishedAt: now - 480, exitCode: 0 }),
      makeJobRow({ id: 'f1', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r1', startedAt: now - 470, finishedAt: now - 450, exitCode: 0 }),
      makeJobRow({ id: 'r2', project: 'proj', kind: 'review', releaseId, startedAt: now - 440, finishedAt: now - 420, exitCode: 0 }),
      makeJobRow({ id: 'f2', project: 'proj', kind: 'fix', releaseId, parentJobId: 'r2', startedAt: now - 410, finishedAt: now - 390, exitCode: 0 }),
      makeJobRow({ id: 'r3', project: 'proj', kind: 'review', releaseId, logPath: reviewLog, startedAt: now - 380, finishedAt: now - 360, exitCode: 0 }),
    ]);

    const f3 = makeFixJob('f3', { releaseId, parentJobId: 'r3', startedAt: now - 30, finishedAt: null, exitCode: null });

    await markDone(f3, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const releaseRow = (await getTestDb().select().from(schema.jobs)).find((row) => row.id === releaseId);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('review_do_not_ship');
  });
});

// Skipped: cap enforcement lives in iteration-caps.ts now (fixIterationCap
// for review/test/commit/push step verification loops; pushFixAttemptCap
// for the separate pre-push-hook rejection retry budget). Tests in
// iteration-caps.test.ts.
describe.skip('fix_max_iterations only caps review-side recovery', () => {
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
    mocks.getSettings.mockReturnValue({
      fix_max_iterations: 1,
    });
  });

  afterEach(() => {
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('still re-runs tests after a failed test fix when fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-test-retry';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 't1', project: 'proj', kind: 'test', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 't1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectTest).toHaveBeenCalledOnce();
    expect(mocks.startProjectTest).toHaveBeenCalledWith('proj');
    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
  });

  it('caps the next review when fix_max_iterations is 1', async () => {
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-1';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledOnce();
    expect(mocks.startProjectCommit).toHaveBeenCalledOnce();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('stops standalone auto-push review exhaustion when the cited review is DO NOT SHIP', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-standalone-review-cap-'));
    try {
      const now = Date.now() / 1000;
      const reviewLog = join(tempDir, 'standalone-review-cap-do-not-ship.log');
      writeFileSync(reviewLog, ndjsonText([
        'Findings:',
        '- Finding ID: auth-bypass',
        'Verdict: DO NOT SHIP',
      ].join('\n')));

      await insertJobsAndCache(getTestDb(), [
        makeJobRow({ id: 'standalone-r1', project: 'proj', kind: 'review', logPath: reviewLog, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
      ]);

      const fixJob = makeFixJob('standalone-f1', { parentJobId: 'standalone-r1', startedAt: now - 30 });

      await markDone(fixJob, 0);

      expect(mocks.startProjectReview).not.toHaveBeenCalled();
      expect(mocks.fileReviewExhaustionIssue).not.toHaveBeenCalled();
      expect(mocks.startProjectCommit).not.toHaveBeenCalled();
      const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
      expect(notifyEvents).toContain('review_do_not_ship');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops the release when exhaustion issue filing succeeds but the follow-up commit cannot start', async () => {
    mocks.startProjectCommit.mockResolvedValueOnce({ ok: false, detail: 'git status failed' });
    const now = Date.now() / 1000;
    const releaseId = 'release-review-cap-commit-fail';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'r1', project: 'proj', kind: 'review', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 0 }),
    ]);

    const fixJob = makeFixJob('f1', { releaseId, parentJobId: 'r1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectReview).not.toHaveBeenCalled();
    expect(mocks.fileReviewExhaustionIssue).toHaveBeenCalledOnce();
    expect(mocks.startProjectCommit).toHaveBeenCalledOnce();
    const releaseRow = (await getTestDb().select().from(schema.jobs)).find((row) => row.id === releaseId);
    expect(releaseRow?.exitCode).toBe(1);
    expect(releaseRow?.finishedAt).not.toBeNull();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
  });

  it('still starts a fix after a capped failed commit inside a release', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-fix';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
    ]);

    const commitJob: JobData = {
      id: 'c1',
      project: 'proj',
      kind: 'commit',
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
      releaseId,
      parentJobId: releaseId,
    };

    await markDone(commitJob, 1);

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('c1');
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).not.toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('suppresses the re-commit after the trailing fix when the commit cap is exhausted', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    const releaseId = 'release-commit-cap-stop';
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: releaseId, project: 'proj', kind: 'release', startedAt: now - 200 }),
      makeJobRow({ id: 'c1', project: 'proj', kind: 'commit', releaseId, startedAt: now - 180, finishedAt: now - 160, exitCode: 1 }),
    ]);

    const fixJob = makeFixJob('f-commit-cap', { releaseId, parentJobId: 'c1', startedAt: now - 30 });

    await markDone(fixJob, 0);

    expect(mocks.startProjectCommit).not.toHaveBeenCalled();
    const notifyEvents = mocks.notify.mock.calls.map((c: unknown[]) => (c[0] as { event?: string })?.event);
    expect(notifyEvents).toContain('fix_loop_exhausted');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });

  it('still starts a fix after a capped failed commit in standalone auto-push mode', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '1';
    const now = Date.now() / 1000;
    await insertJobsAndCache(getTestDb(), [
      makeJobRow({ id: 'old-commit', project: 'proj', kind: 'commit', startedAt: now - 120, finishedAt: now - 110, exitCode: 1 }),
    ]);

    const commitJob: JobData = {
      id: 'standalone-commit',
      project: 'proj',
      kind: 'commit',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: now - 20,
      finishedAt: null,
      exitCode: null,
      seen: false,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreateTokens: null,
      sessionId: null,
    };

    await markDone(commitJob, 1);

    expect(mocks.startFixFromJob).toHaveBeenCalledOnce();
    expect(mocks.startFixFromJob).toHaveBeenCalledWith('standalone-commit');
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  });
});
