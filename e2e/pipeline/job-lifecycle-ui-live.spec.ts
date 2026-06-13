import { test, expect } from '@playwright/test';
import { PROJECT, mockJobScenario, makeJob, now } from './job-lifecycle-ui-fixtures';

test.describe('Job lifecycle UI badges', () => {
  test('history tab flips a running job to done without reload', async ({ page }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-1',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-1',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab flips a running job to failed without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-failed',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 5,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-failed',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('exit 5', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  test('history tab surfaces failure detail after a running job fails via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureDetail = 'Unit test failed: expected checkout guard to block unsafe branch switch';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-failed-detail',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-failed-detail',
        work_summary: serveRunning ? null : failureDetail,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureDetail)).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('running filter clears and failed filter picks up a test job failure without reload', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureDetail = 'Integration tests failed after the worker exited with code 4';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-filter-failure',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 4,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-filter-failure',
        work_summary: serveRunning ? 'Tests are still running' : failureDetail,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^running \d+$/i }).click();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row).toHaveCount(0);

    const failedFilter = page.getByRole('button', { name: /^failed 1$/i });
    await expect(failedFilter).toBeVisible({ timeout: 12_000 });
    await failedFilter.click();

    const failedRow = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: failureDetail })
      .first();
    await expect(failedRow).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByText('exit 4', { exact: true })).toBeVisible();
    await expect(failedRow.getByLabel('running')).toHaveCount(0);
  });

  test('history tab flips a running job to cancelled without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-cancelled',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-cancelled',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  test('running filter clears when a job is cancelled via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-filter-cancelled',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-filter-cancelled',
        work_summary: serveRunning ? 'Tests are still running' : 'Cancelled by operator',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^running \d+$/i }).click();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: /^all \d+$/i }).click();

    const cancelledRow = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'Cancelled by operator' })
      .first();
    await expect(cancelledRow).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(cancelledRow.getByLabel('running')).toHaveCount(0);
  });

  test('history release row surfaces stop reason when it settles without child steps', async ({
    page,
  }) => {
    let serveRunning = true;
    const stopReason = 'review startup failed: prerequisite command exited 1';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-release-blocked-stop-reason',
        kind: 'release',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 4,
        context_meta: serveRunning
          ? null
          : JSON.stringify({ releaseStopReason: stopReason }),
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'release' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText(stopReason)).toHaveCount(0);

    serveRunning = false;

    await expect(row.getByText('release blocked', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.getByText(stopReason, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running agent job with non-null work_summary shows
  // liveDetail text, then transitions to completed work_summary on done.
  //
  // Agent and run jobs are "conversational rows" (isConversationalRow=true)
  // and render their work_summary as live progress text while running. This
  // path is distinct from the default subtitle/null path tested elsewhere.
  // -------------------------------------------------------------------------
  test('running agent job shows live work_summary text in history row, then updates on completion', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Analyzing 12 TypeScript files for type errors...';
    const doneText = 'Completed. Found 0 errors across 12 files.';

    // Agent jobs use kind='agent:<name>' — the 'agent:' prefix maps the kind
    // to bucket='agent' (isConversationalRow=true). Bare 'agent' maps to
    // bucket='other' which suppresses the liveDetail work_summary path.
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-agent-live-summary',
        kind: 'agent:lint',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-agent-live-summary',
        work_summary: serveRunning ? liveText : doneText,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    // 'agent:lint' → bucket='agent' → KIND_LABEL chip shows 'agent'; title shows 'lint'
    const row = page.getByRole('button')
      .filter({ hasText: 'agent' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // liveDetail path: agent is a conversational row (bucket='agent'), so non-null
    // work_summary renders as the in-progress detail text below the row heading.
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    // After completion the row flips to done and the final work_summary replaces
    // the live progress text. No page reload should be needed.
    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(doneText, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running run job shows live work_summary text (same
  // conversational-row code path as agent, but with kind='run').
  // -------------------------------------------------------------------------
  test('running chat run shows live work_summary text and clears it on cancellation', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Refactoring the auth module...';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-live-summary-cancel',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 20,
        finished_at: serveRunning ? null : now() - 3,
        session_id: 'sess-run-live-cancel',
        work_summary: serveRunning ? liveText : null,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    // 'run' kind displays as 'Chat' in KIND_LABEL, not 'run'. Filter by the
    // session or a unique attribute. Use the session row label pattern instead.
    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    // Live progress text clears after cancellation — no orphaned progress message.
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running review job flips to a verdict badge via poll.
  //
  // VerdictBadge renders null while a review job is running (isRunning short-
  // circuits before the verdict text). Only once the job settles to done with
  // a verdict does the "⚠ ATTN" / "✗ DNS" / "✓ LGTM" pill appear. Existing live
  // transition tests use kind='test' (raw exit codes) or the overview banner;
  // none assert the review-specific verdict badge appearing live in a row.
  // -------------------------------------------------------------------------
  test('history tab review row gains the ⚠ ATTN verdict badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-review-attn',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        // Verdict is only known once the review finishes; absent while running.
        verdict: serveRunning ? undefined : 'NEEDS ATTENTION',
        session_id: 'sess-live-review-attn',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // While running, no verdict pill is rendered yet.
    await expect(row.getByText('⚠ ATTN')).toHaveCount(0);

    serveRunning = false;

    // The verdict badge appears on the next poll cycle without a reload.
    await expect(row.getByText('⚠ ATTN')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab review row gains the ✗ DNS verdict badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-review-dns',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        verdict: serveRunning ? undefined : 'DO NOT SHIP',
        session_id: 'sess-live-review-dns',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('✗ DNS')).toHaveCount(0);

    serveRunning = false;

    await expect(row.getByText('✗ DNS')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0, { timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // History tab — two concurrent jobs hold independent state
  // Both a test and a review job run at once; when the test job fails the
  // review job must keep its running badge (no cross-row contamination), then
  // each row settles to its own terminal outcome.
  // -------------------------------------------------------------------------
  test('history tab keeps two concurrent jobs independent as each settles via poll', async ({
    page,
  }) => {
    // Use non-pipeline kinds (agent + run) so the two orphaned jobs are NOT
    // clustered into a virtual "Pipeline steps" group by the history util.
    let phase: 'both-running' | 'first-failed' | 'all-done' = 'both-running';
    await mockJobScenario(page, () => {
      const firstRunning = phase === 'both-running';
      const secondRunning = phase !== 'all-done';

      return [
        makeJob({
          id: 'job-concurrent-a',
          kind: 'agent',
          status: firstRunning ? 'running' : 'done',
          exit_code: firstRunning ? null : 1,
          started_at: now() - 40,
          finished_at: firstRunning ? null : now() - 6,
          session_id: 'sess-concurrent-a',
        }),
        makeJob({
          id: 'job-concurrent-b',
          kind: 'run',
          status: secondRunning ? 'running' : 'done',
          exit_code: secondRunning ? null : 0,
          started_at: now() - 35,
          finished_at: secondRunning ? null : now() - 3,
          session_id: 'sess-concurrent-b',
        }),
      ];
    });

    await page.goto(`/project/${PROJECT}/history`);

    const agentRow = page.getByRole('button')
      .filter({ hasText: 'agent' })
      .filter({ hasText: 'started' })
      .first();
    const runRow = page.getByRole('button')
      .filter({ hasText: 'run' })
      .filter({ hasText: 'started' })
      .first();

    // Both jobs start out running, each with its own running badge.
    await expect(agentRow.getByLabel('running')).toBeVisible();
    await expect(runRow.getByLabel('running')).toBeVisible();

    // The agent job fails while the run job keeps running — the run row must
    // not pick up the failure state.
    phase = 'first-failed';

    await expect(agentRow.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(agentRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(runRow.getByLabel('running')).toBeVisible();
    await expect(runRow.getByText('exit 1')).toHaveCount(0);

    // Run job then completes successfully; the agent row stays failed.
    phase = 'all-done';

    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(agentRow.getByText('exit 1', { exact: true })).toBeVisible();
  });

  test('failed filter count increments when a running job fails beside an existing failure', async ({
    page,
  }) => {
    let serveRunning = true;
    const existingFailure = 'Existing failed run kept for comparison';
    const newFailure = 'Second provider run failed after initial streaming output';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-existing-failure-peer',
        kind: 'run',
        status: 'done',
        exit_code: 1,
        started_at: now() - 90,
        finished_at: now() - 70,
        session_id: 'sess-existing-failure-peer',
        work_summary: existingFailure,
      }),
      makeJob({
        id: 'job-running-failure-peer',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 2,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-running-failure-peer',
        work_summary: serveRunning
          ? 'Streaming output before the second run fails'
          : newFailure,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const existingRow = page.getByRole('button')
      .filter({ hasText: existingFailure })
      .first();
    const liveRow = page.getByRole('button')
      .filter({ hasText: 'Streaming output before the second run fails' })
      .first();

    await expect(existingRow.getByText('exit 1', { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(liveRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^failed 1$/i })).toBeVisible();

    serveRunning = false;

    await expect(page.getByRole('button', { name: /^running 1$/i })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^failed 2$/i })).toBeVisible({
      timeout: 12_000,
    });

    await page.getByRole('button', { name: /^failed 2$/i }).click();

    await expect(existingRow).toBeVisible();
    const failedPeerRow = page.getByRole('button')
      .filter({ hasText: newFailure })
      .first();
    await expect(failedPeerRow).toBeVisible({ timeout: 12_000 });
    await expect(failedPeerRow.getByText('exit 2', { exact: true })).toBeVisible();
    await expect(failedPeerRow.getByLabel('running')).toHaveCount(0);
    await expect(page.getByText('Streaming output before the second run fails')).toHaveCount(0);
  });

  test('running filter keeps the remaining active row when one concurrent job completes', async ({
    page,
  }) => {
    let phase: 'both-running' | 'first-done' = 'both-running';
    const firstLive = 'First agent is still preparing the workspace';
    const firstDone = 'First agent completed its handoff';
    const secondLive = 'Second agent keeps running after the first completes';

    await mockJobScenario(page, () => {
      const firstRunning = phase === 'both-running';

      return [
        makeJob({
          id: 'job-running-filter-agent-first',
          kind: 'agent:first',
          status: firstRunning ? 'running' : 'done',
          exit_code: firstRunning ? null : 0,
          started_at: now() - 45,
          finished_at: firstRunning ? null : now() - 6,
          session_id: 'sess-running-filter-agent-first',
          work_summary: firstRunning ? firstLive : firstDone,
        }),
        makeJob({
          id: 'job-running-filter-agent-second',
          kind: 'agent:second',
          status: 'running',
          exit_code: null,
          started_at: now() - 35,
          finished_at: null,
          session_id: 'sess-running-filter-agent-second',
          work_summary: secondLive,
        }),
      ];
    });

    await page.goto(`/project/${PROJECT}/history`);

    const firstRow = page.getByRole('button')
      .filter({ hasText: firstLive })
      .first();
    const secondRow = page.getByRole('button')
      .filter({ hasText: secondLive })
      .first();

    await expect(firstRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });
    await expect(secondRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: /^running 2$/i }).click();
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();

    phase = 'first-done';

    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText(firstLive)).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText(firstDone)).toHaveCount(0);
    await expect(secondRow).toBeVisible({ timeout: 12_000 });
    await expect(secondRow.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^all 2$/i }).click();
    const finishedFirstRow = page.getByRole('button')
      .filter({ hasText: firstDone })
      .first();
    await expect(finishedFirstRow).toBeVisible({ timeout: 12_000 });
    await expect(finishedFirstRow.getByLabel('running')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — failed run job surfaces workSummary via ownSummary path.
  //
  // RunRow.ownSummary = isConversationalRow ? formatRunSummaryText(e.workSummary) : null
  // runSummary = effectiveRunning ? null : (ownFailureDetail ?? ownSummary ?? ...)
  //
  // For a failed run job with no detail but a workSummary, runSummary = ownSummary
  // = workSummary. Existing tests cover the cancelled path (work_summary → null)
  // and the successful path — this test covers the failure path where workSummary
  // carries the failure reason and must survive the running→failed transition.
  // -------------------------------------------------------------------------
  test('failed chat run surfaces workSummary text via poll without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Scaffolding the new auth middleware...';
    const failureText = 'Run failed: auth provider rejected the connection.';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-fail-summary',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 25,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-run-fail-summary',
        work_summary: serveRunning ? liveText : failureText,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // While running, liveDetail shows the in-progress workSummary.
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    // After failure: exit 1 badge appears, live liveText replaced by failureText
    // via runSummary (ownSummary path), running badge clears.
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureText, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history chat row gains unfinished outcome badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-outcome-needs-continue',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-run-outcome-needs-continue',
        context_meta: serveRunning
          ? null
          : JSON.stringify({ outcomeClassification: { verdict: 'needs_continue' } }),
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('↻ unfinished')).toHaveCount(0);

    serveRunning = false;

    const outcomeBadge = row.getByText('↻ unfinished', { exact: true });
    await expect(outcomeBadge).toBeVisible({ timeout: 12_000 });
    await expect(outcomeBadge).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: needs continue',
    );
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab flips a running test job to "failed to start" via poll when exit_code is -1', async ({ page }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-test-spawn-fail-live',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -1,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-test-spawn-fail-live',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('failed to start', { exact: true })).toBeVisible({ timeout: 12_000 });
    // Must never show the raw sentinel.
    await expect(row.getByText('exit -1', { exact: true })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running filter clears and job appears in all filter on success
  //
  // The filter-transition tests for failure (exit 4) and cancellation (exit -3)
  // are already covered. This test pins the success path: the running filter
  // empties when the job finishes with exit_code=0, and switching back to "all"
  // shows the settled row with a "done" badge — no orphaned running badge.
  // -------------------------------------------------------------------------
  test('running filter clears and all-filter shows done badge when a running job succeeds via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Linting all modified TypeScript files...';
    const doneText = 'Lint completed. No issues found.';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-filter-success',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 40,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-filter-success',
        work_summary: serveRunning ? liveText : doneText,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^running \d+$/i }).click();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    // Running filter empties — no stale row left under the running view.
    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row).toHaveCount(0);

    // The "failed" filter chip must NOT appear for a successful completion.
    await expect(page.getByRole('button', { name: /^failed \d+$/i })).toHaveCount(0, {
      timeout: 12_000,
    });

    // Switch to "all" and verify the settled row shows "done" — no running badge.
    await page.getByRole('button', { name: /^all \d+$/i }).click();

    const doneRow = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: doneText })
      .first();
    await expect(doneRow).toBeVisible({ timeout: 12_000 });
    await expect(doneRow.getByLabel('done')).toBeVisible();
    await expect(doneRow.getByLabel('running')).toHaveCount(0);
    await expect(doneRow.getByText('running', { exact: true })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — new running job appears via poll from empty state
  //
  // Complements the transition tests above (which always start with a running
  // job already present). This test verifies that the history tab picks up a
  // brand-new running job row via polling when the page was already open and
  // showing the empty state — the row with spinner must appear without reload.
  // -------------------------------------------------------------------------
  test('history tab shows new running job row with spinner when it appears via poll from empty state', async ({
    page,
  }) => {
    let serveRunning = false;
    await mockJobScenario(page, () =>
      serveRunning
        ? [
            makeJob({
              id: 'job-live-history-appear',
              kind: 'run',
              status: 'running',
              exit_code: null,
              started_at: now() - 3,
              finished_at: null,
              session_id: 'sess-live-history-appear',
              work_summary: 'Running task just started.',
            }),
          ]
        : [],
    );
    // mockJobScenario does not stub /api/jobs/counts; add it here so the
    // RunsHeader subtitle ("1 running") reflects the mocked jobs state.
    await page.route(
      (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
      (route) => {
        const running = serveRunning ? 1 : 0;
        route.fulfill({
          json: {
            total: running,
            byKind: running ? { run: 1 } : {},
            byStatus: { running, done: 0, aborted: 0, failed: 0 },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Empty state must be visible before the job starts.
    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 });

    // New running job starts — flip the mock.
    serveRunning = true;

    // History tab picks up the new running job on the next poll cycle.
    const row = page.getByRole('button')
      .filter({ hasText: 'run' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('running', { exact: true })).toBeVisible({ timeout: 8_000 });
    // RunsHeader subtitle should show the live running count.
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // RunsHeader subtitle clears when the last running job completes
  //
  // Existing transition tests verify the row-level badge clears, but not the
  // "N running" subtitle text in RunsHeader. This test specifically pins that
  // the subtitle disappears when the running count drops to 0 via polling.
  // -------------------------------------------------------------------------
  test('history tab RunsHeader subtitle clears after the last running job completes via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-header-subtitle-clear',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 20,
        finished_at: serveRunning ? null : now() - 2,
        session_id: 'sess-header-subtitle-clear',
      }),
    ]);
    await page.route(
      (url) =>
        url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
      (route) => {
        const running = serveRunning ? 1 : 0;
        route.fulfill({
          json: {
            total: 1,
            byKind: { run: 1 },
            byStatus: { running, done: serveRunning ? 0 : 1, aborted: 0, failed: 0 },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Subtitle must be visible while the job is running.
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 8_000 });

    // Job completes — flip the mock.
    serveRunning = false;

    // RunsHeader subtitle must disappear once running count is 0.
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    // The row itself must still be visible (now done, not gone).
    const row = page.getByRole('button')
      .filter({ hasText: 'run' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByLabel('running')).toHaveCount(0);
  });
});
