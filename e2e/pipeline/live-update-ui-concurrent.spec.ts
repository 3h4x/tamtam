import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';
import {
  PROJECT,
  captureReactKeyWarnings,
  historyRowByTitle,
  makeJob,
  now,
  runningRunRows,
  stubCommonRoutes,
} from './live-update-ui-fixtures';

// ─── Test 2d: Project history concurrent rows ───────────────────────────────
//
// ProjectRunsTab groups and re-renders rows on every poll tick. Verify two
// active rows in the same project stay independent as one completes, and
// confirm React does not emit duplicate-key warnings while doing so.

test.describe('Project history concurrent rows', () => {
  test('history tab shows two simultaneous running rows without React key warnings', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob('history-test-running', PROJECT, 'running', null, 'test', {
                startedAt: testStartedAt,
              }),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(testRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job finishes and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    let testDone = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob(
                'history-test-transition',
                PROJECT,
                testDone ? 'done' : 'running',
                testDone ? 0 : null,
                'test',
                {
                  startedAt: testStartedAt,
                  finishedAt: testDone ? testStartedAt + 20 : null,
                },
              ),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testDone = true;

    await expect(testRow.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job is cancelled and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    let testCancelled = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob(
                'history-test-cancel-transition',
                PROJECT,
                testCancelled ? 'done' : 'running',
                testCancelled ? -3 : null,
                'test',
                {
                  startedAt: testStartedAt,
                  finishedAt: testCancelled ? testStartedAt + 20 : null,
                },
              ),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testCancelled = true;

    await expect(testRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job fails and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const failureReason = 'Tests failed after the smoke check timed out.';
    let testFailed = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                  startedAt: reviewStartedAt,
                }),
                work_summary: 'Code review is still running.',
              },
              {
                ...makeJob(
                  'history-test-fail-transition',
                  PROJECT,
                  testFailed ? 'done' : 'running',
                  testFailed ? 1 : null,
                  'test',
                  {
                    startedAt: testStartedAt,
                    finishedAt: testFailed ? testStartedAt + 20 : null,
                  },
                ),
                work_summary: testFailed ? failureReason : 'Tests are still running.',
              },
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testFailed = true;

    await expect(testRow.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(testRow.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });
});
