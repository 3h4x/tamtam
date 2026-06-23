import { expect, test, Route } from '@playwright/test';

test('project setup wizard walks the happy path', async ({ page }) => {
  const project = 'demoproj';
  let setupState: Record<string, string> = {};
  let setupComplete = false;
  let jobDone = false;

  await page.route(`**/api/projects/by-project/${project}/setup`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          project,
          setup_complete: setupComplete,
          setup_state: setupState,
          detection: {
            test_command: 'pnpm test',
            default_branch: 'main',
            github_remote: 'git@github.com:owner/demoproj.git',
            github_repo: 'owner/demoproj',
            gh_auth: { available: true, detail: null },
            ci_workflow: true,
          },
        },
      });
      return;
    }
    const body = await route.request().postDataJSON();
    if (body.step && body.status) setupState[body.step] = body.status;
    if (body.write_file_config) setupState.file_config = 'completed';
    if (body.setup_complete) {
      setupComplete = true;
      for (const step of ['detect', 'pipeline', 'automation', 'notifications', 'file_config', 'smoke_test']) {
        setupState[step] = setupState[step] ?? 'skipped';
      }
    }
    await route.fulfill({ json: { status: 'ok', setup_complete: setupComplete, setup_state: setupState } });
  });

  await page.route(`**/api/projects/by-project/${project}/config`, async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ json: { status: 'ok' } });
      return;
    }
    await route.fulfill({
      json: {
        project,
        test_command: 'pnpm test',
        detected_test_command: 'pnpm test',
        effective_test_command: 'pnpm test',
        test_cron_enabled: false,
        test_cron_schedule: '',
        auto_commit_enabled: false,
        auto_push_enabled: false,
        auto_pr_merge_enabled: false,
        release_after_run: false,
        issue_auto_branch: true,
        tests_disabled: false,
        review_disabled: false,
        setup_complete: setupComplete,
        setup_state: setupState,
      },
    });
  });

  await page.route(`**/api/projects/by-project/${project}/test`, async (route: Route) => {
    jobDone = false;
    await route.fulfill({ json: { status: 'started', job_id: 'test-job-1', pid: 123, log_path: '/tmp/test.log' } });
    setTimeout(() => { jobDone = true; }, 50);
  });

  await page.route('**/api/jobs/test-job-1', async (route: Route) => {
    await route.fulfill({
      json: {
        id: 'test-job-1',
        status: jobDone ? 'done' : 'running',
        exit_code: jobDone ? 0 : null,
      },
    });
  });

  await page.goto(`/project/${project}/setup`);
  await expect(page.getByRole('heading', { name: `${project} setup` })).toBeVisible();

  await page.getByRole('button', { name: 'Mark done' }).first().click();
  await expect(page.getByText('Detect: completed')).toBeVisible();

  await page.getByLabel('Release after runs').check();
  await page.getByRole('button', { name: 'Save pipeline' }).click();
  await expect(page.getByText('Pipeline: completed')).toBeVisible();

  await page.getByLabel('Auto commit').check();
  await page.getByLabel('Auto push').check();
  await page.getByRole('button', { name: 'Save automation' }).click();
  await expect(page.getByText('Automation: completed')).toBeVisible();

  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Finished with exit code')).toBeVisible();

  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(`/project/${project}/config`);
});
