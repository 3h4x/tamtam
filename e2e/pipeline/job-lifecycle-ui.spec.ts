import { test, expect } from '@playwright/test';
import { PROJECT, mockJobScenario, makeJob, now, type MockJob } from './job-lifecycle-ui-fixtures';

test.describe('Job lifecycle UI badges', () => {
  // -------------------------------------------------------------------------
  // History tab — running job
  // -------------------------------------------------------------------------
  test('running job shows "running" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-running-1',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 30,
        finished_at: null,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "running" when status === 'running'
    await expect(page.getByText('running').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed job
  // -------------------------------------------------------------------------
  test('failed job shows "exit 1" badge in history tab', async ({ page }) => {
    // Use kind:'test' — review jobs with no verdict show "review verdict missing"
    // instead of the raw exit code, masking the "exit N" badge we want to test.
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-1',
        kind: 'test',
        status: 'done',
        exit_code: 1,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('exit 1').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — cancelled job (exit -3 = aborted pipeline)
  // RunRow maps exit_code=-3 to the "cancelled" label via statusFailureLabel.
  // -------------------------------------------------------------------------
  test('aborted job shows "cancelled" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-cancelled-1',
        kind: 'test',
        status: 'done',
        exit_code: -3,
        started_at: now() - 90,
        finished_at: now() - 60,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('cancelled').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — successful job with LGTM verdict
  // -------------------------------------------------------------------------
  test('LGTM review shows "✓ LGTM" verdict badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-lgtm-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'LGTM',
        session_id: 'sess-lgtm-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "✓ LGTM" for a done job with verdict === 'LGTM'
    await expect(page.getByText('✓ LGTM').first()).toBeVisible();
  });

  test('run row shows the newest nested release outcome when multiple releases share the same parent', async ({ page }) => {
    const ts = now();
    const jobs: MockJob[] = [
      makeJob({
        id: 'chat-run-1',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: ts - 500,
        finished_at: ts - 490,
        session_id: 'sess-run-1',
      }),
      makeJob({
        id: 'release-old',
        kind: 'release',
        status: 'done',
        exit_code: 0,
        started_at: ts - 480,
        finished_at: ts - 420,
        parent_job_id: 'chat-run-1',
      }),
      makeJob({
        id: 'release-new',
        kind: 'release',
        status: 'running',
        exit_code: null,
        started_at: ts - 120,
        finished_at: null,
        parent_job_id: 'chat-run-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    const runRow = page.getByRole('button').filter({ hasText: '(empty prompt)' }).first();
    await expect(runRow.getByText('release running')).toBeVisible();
    await expect(runRow.getByText('✓ release done')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — NEEDS ATTENTION verdict
  // -------------------------------------------------------------------------
  test('NEEDS ATTENTION review shows "⚠ ATTN" verdict badge', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-attn-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'NEEDS ATTENTION',
        session_id: 'sess-attn-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('⚠ ATTN').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — DO NOT SHIP verdict
  // -------------------------------------------------------------------------
  test('DO NOT SHIP review shows "✗ DNS" verdict badge', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-dns-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'DO NOT SHIP',
        session_id: 'sess-dns-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "✗ DNS" for verdict === 'DO NOT SHIP'
    await expect(page.getByText('✗ DNS').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — successful job without verdict shows "done"
  // -------------------------------------------------------------------------
  test('completed push job shows "done" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-done-push',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // A push job has no verdict — VerdictBadge shows "done"
    await expect(page.getByText('done').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — running filter shows only running jobs
  // -------------------------------------------------------------------------
  test('running filter in history tab shows only the running job', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-running-f',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 5,
        finished_at: null,
      }),
      makeJob({
        id: 'job-done-f',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // Click the "running" filter chip
    await page.getByRole('button', { name: /running/i }).first().click();
    // Only the running row should be visible, "done" badge should be gone
    await expect(page.getByText('running').first()).toBeVisible();
    await expect(page.getByText('done')).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed filter shows only failed jobs
  //
  // Use only one job so the orphaned-pipeline-step clustering logic doesn't
  // collapse the failed and success rows into a single virtual group (which
  // would replace the exact exit code with a normalized "exit 1").
  // -------------------------------------------------------------------------
  test('failed filter in history tab shows only failed jobs', async ({ page }) => {
    // Use kind:'test' so the failure shows the raw exit code badge ("exit 2").
    // Review jobs with no verdict render "review verdict missing" instead.
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-f',
        kind: 'test',
        status: 'done',
        exit_code: 2,
        started_at: now() - 60,
        finished_at: now() - 30,
        session_id: 'sess-failed-f',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // The "failed" filter chip is only rendered when there are failed entries.
    await page.getByRole('button', { name: /failed/i }).first().click();
    await expect(page.getByText('exit 2').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed run job surfaces detail over workSummary.
  //
  // RunRow.ownFailureDetail = !running && effectiveNeedsAttention && isConversationalRow
  //   ? formatRunSummaryText(e.detail) : null
  // runSummary = ownFailureDetail ?? ownSummary ?? ...
  //
  // When a run job fails with both detail and workSummary, detail takes
  // precedence (ownFailureDetail ?? ownSummary). Neither path is tested for
  // the conversational failure case without explicit test coverage.
  // -------------------------------------------------------------------------
  test('failed chat run shows detail text (not workSummary) when both are present', async ({
    page,
  }) => {
    const detailText = 'Provider error: token limit exceeded on attempt 3.';
    const workSummaryText = 'Refactored the token cache layer.';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-detail-precedence',
        kind: 'run',
        status: 'done',
        exit_code: 1,
        started_at: now() - 60,
        finished_at: now() - 10,
        session_id: 'sess-run-detail-precedence',
        work_summary: workSummaryText,
      }),
    ]);

    // The makeJob helper does not support the detail field — add it via a
    // separate route override by extending the base mock. We use a fresh
    // page.route after mockJobScenario to inject the extra field.
    // Playwright matches later-registered routes first, so this overrides
    // the job list returned by mockJobScenario.
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route) => {
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'job-run-detail-precedence',
                project: PROJECT,
                kind: 'run',
                status: 'done',
                exit_code: 1,
                started_at: now() - 60,
                finished_at: now() - 10,
                pid: 0,
                log_path: '',
                seen: true,
                session_id: 'sess-run-detail-precedence',
                work_summary: workSummaryText,
                detail: detailText,
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    // detail takes precedence over workSummary via ownFailureDetail ?? ownSummary.
    await expect(row.getByText(detailText, { exact: false })).toBeVisible({ timeout: 8_000 });
    // workSummary must NOT be shown when detail is present for a failed run row.
    await expect(row.getByText(workSummaryText, { exact: false })).toHaveCount(0);
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  test('history review row shows follow-up issue link and alert prompt-size chip', async ({
    page,
  }) => {
    const followupUrl = 'https://github.com/example/repo/issues/42';
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-review-followup-prompt-alert',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 80,
        finished_at: now() - 20,
        verdict: 'DO NOT SHIP',
        session_id: 'sess-review-followup-prompt-alert',
        prompt_bytes: 52_224,
        context_meta: JSON.stringify({
          followupIssueUrl: followupUrl,
          followupIssueNumber: 42,
        }),
      }),
      makeJob({
        id: 'job-run-prompt-below-threshold',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 90,
        session_id: 'sess-run-prompt-below-threshold',
        prompt_bytes: 19_456,
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    const reviewRow = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(reviewRow).toBeVisible();

    const followupLink = reviewRow.getByRole('link', { name: '↗ filed #42' });
    await expect(followupLink).toBeVisible();
    await expect(followupLink).toHaveAttribute('href', followupUrl);

    const promptChip = reviewRow.getByText('prompt 51KB', { exact: true });
    await expect(promptChip).toBeVisible();
    await expect(promptChip).toHaveClass(/text-status-error/);
    await expect(promptChip).toHaveAttribute(
      'title',
      /Prompt piped to provider: 52,224 bytes/,
    );

    await expect(page.getByText('prompt 19KB', { exact: true })).toHaveCount(0);
  });

  test('history chat rows show done and asked outcome chips with their tones', async ({
    page,
  }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-run-outcome-done',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 40,
        finished_at: now() - 10,
        session_id: 'sess-run-outcome-done',
        context_meta: JSON.stringify({ outcomeClassification: { verdict: 'done' } }),
      }),
      makeJob({
        id: 'job-run-outcome-asked',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 90,
        session_id: 'sess-run-outcome-asked',
        context_meta: JSON.stringify({ outcomeClassification: { verdict: 'asked_question' } }),
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    // `done` → "✓ done", success tone.
    const doneChip = page.getByText('✓ done', { exact: true });
    await expect(doneChip).toBeVisible();
    await expect(doneChip).toHaveClass(/text-status-success/);
    await expect(doneChip).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: done',
    );

    // `asked_question` → "? asked", info tone.
    const askedChip = page.getByText('? asked', { exact: true });
    await expect(askedChip).toBeVisible();
    await expect(askedChip).toHaveClass(/text-status-info/);
    await expect(askedChip).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: asked question',
    );
  });

  test('history row shows warn-tone prompt chip at the 20KB boundary', async ({
    page,
  }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-run-prompt-warn-boundary',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 20,
        session_id: 'sess-run-prompt-warn-boundary',
        // Exactly the warn threshold (PROMPT_BYTES_WARN = 20_000), below the
        // alert threshold (50_000) — chip shows in warning tone, not error.
        prompt_bytes: 20_000,
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();

    const promptChip = row.getByText('prompt 20KB', { exact: true });
    await expect(promptChip).toBeVisible();
    await expect(promptChip).toHaveClass(/text-status-warning/);
    // Must NOT escalate to the alert (error) styling at the warn boundary.
    await expect(promptChip).not.toHaveClass(/text-status-error/);
    await expect(promptChip).toHaveAttribute(
      'title',
      /Prompt piped to provider: 20,000 bytes/,
    );
  });

  // -------------------------------------------------------------------------
  // History tab — exit_code = -1 shows "failed to start" not "exit -1"
  //
  // RunRow: failedText = failureLabel ?? (exitCode === -1 ? 'failed to start' : `exit ${exitCode}`)
  //
  // exit_code=-1 is the sentinel for spawn/exec failure (the process could not
  // be launched at all). Displaying the raw "exit -1" is meaningless to the
  // user — "failed to start" is the expected label. This path is already
  // covered for custom-action jobs but was untested for standard job kinds
  // (test, run, agent) where failureLabel is null by default.
  // -------------------------------------------------------------------------
  test('test job with exit_code -1 shows "failed to start" not "exit -1"', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-test-spawn-fail',
        kind: 'test',
        status: 'done',
        exit_code: -1,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByText('failed to start', { exact: true })).toBeVisible();
    // The meaningless sentinel value must never appear.
    await expect(row.getByText('exit -1', { exact: true })).toHaveCount(0);
  });

  test('agent job with exit_code -1 shows "failed to start" not "exit -1"', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-agent-spawn-fail',
        kind: 'agent:deploy',
        status: 'done',
        exit_code: -1,
        started_at: now() - 120,
        finished_at: now() - 90,
        session_id: 'sess-agent-spawn-fail',
        work_summary: 'Agent process could not be launched.',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'agent' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByText('failed to start', { exact: true })).toBeVisible();
    await expect(row.getByText('exit -1', { exact: true })).toHaveCount(0);
    // work_summary is present and should also be visible as the failure detail.
    await expect(row.getByText('Agent process could not be launched.', { exact: false })).toBeVisible();
  });
});
