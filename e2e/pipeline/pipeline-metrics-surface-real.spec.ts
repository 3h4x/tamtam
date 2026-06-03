import { test, expect } from '@playwright/test';
import {
  acquirePipelineSharedStateLock,
  type PipelineSharedStateLock,
  writeScenario,
  resetShimState,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

// After a real LGTM release completes, the /pipeline metrics page must reflect
// it. Scoping the page to the project filter (?project=<slug>) isolates the
// assertions from releases other specs accumulate in the shared E2E DB, and the
// per-project cache key is uncached until this spec's first fetch — so the page
// computes fresh from the just-finished release rather than a stale snapshot.
const PROJECT = 'pipeline-metrics-surface';
const FAILURE_PROJECT = 'pipeline-metrics-failure-surface';
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';

const SCENARIO = [
  {
    label: 'review',
    text: 'The implementation is clean and safe to ship.\n\nVerdict: LGTM',
  },
  { label: 'commit-message', text: 'feat: pipeline metrics surface' },
];

const FAILURE_SCENARIO = [
  {
    label: 'review',
    text: 'The release contains a blocking regression and must not ship.\n\nVerdict: DO NOT SHIP',
  },
];

test.describe('Real pipeline metrics surface', () => {
  let sharedStateLock: PipelineSharedStateLock | null = null;

  test.afterEach(async ({ request }) => {
    if (!sharedStateLock) return;
    try {
      const patch = await request.patch('/api/settings', {
        data: { review_do_not_ship_action: DEFAULT_DO_NOT_SHIP_ACTION },
      });
      expect(
        patch.ok(),
        `failed to restore review_do_not_ship_action: ${patch.status()}`,
      ).toBe(true);
    } finally {
      sharedStateLock.release();
      sharedStateLock = null;
    }
  });

  test('a completed LGTM release shows 100% success and an LGTM verdict on /pipeline', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should succeed').toBe(0);

    await page.goto(`/pipeline?project=${PROJECT}`);

    // Project-scoped header confirms the filter is applied.
    const heading = page.getByRole('heading', { name: 'Pipeline Metrics' });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expect(heading.getByText(PROJECT)).toBeVisible();

    // Pipeline success card: the label div's parent is the card, where the
    // value (100%) and sub ("1/1 releases") are unique within that card.
    const successCard = page.getByText('Pipeline success', { exact: true }).locator('..');
    await expect(successCard.getByText('1/1 releases')).toBeVisible({ timeout: 15_000 });
    await expect(successCard.getByText('100%')).toBeVisible();

    // Review LGTM rate card: the single review returned LGTM.
    const lgtmCard = page.getByText('Review LGTM rate', { exact: true }).locator('..');
    await expect(lgtmCard.getByText('1/1 reviews')).toBeVisible();
    await expect(lgtmCard.getByText('100%')).toBeVisible();

    // Verdict distribution legend names the LGTM segment with its count.
    await expect(page.getByText('LGTM', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1 (100%)')).toBeVisible();

    // The empty-state hint must not appear when data exists.
    await expect(page.getByText('No pipeline data in the last window.')).toHaveCount(0);
  });

  test('a blocked release shows 0% success and a DO NOT SHIP verdict on /pipeline', async ({
    page,
    request,
  }) => {
    sharedStateLock = await acquirePipelineSharedStateLock('pipeline-metrics-failure-surface');
    writeScenario(FAILURE_PROJECT, FAILURE_SCENARIO);
    resetShimState(FAILURE_PROJECT);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    });
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);

    const releaseResp = await request.post(`/api/projects/by-project/${FAILURE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const result = await waitForPipelineCompletion(request, FAILURE_PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail').not.toBe(0);

    await page.goto(`/pipeline?project=${FAILURE_PROJECT}`);

    const heading = page.getByRole('heading', { name: 'Pipeline Metrics' });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expect(heading.getByText(FAILURE_PROJECT)).toBeVisible();

    const successCard = page.getByText('Pipeline success', { exact: true }).locator('..');
    await expect(successCard.getByText('0/1 releases')).toBeVisible({ timeout: 15_000 });
    await expect(successCard.getByText('0%')).toBeVisible();

    const lgtmCard = page.getByText('Review LGTM rate', { exact: true }).locator('..');
    await expect(lgtmCard.getByText('0/1 reviews')).toBeVisible();
    await expect(lgtmCard.getByText('0%')).toBeVisible();

    await expect(page.getByText('DO NOT SHIP', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1 (100%)')).toBeVisible();
    await expect(page.getByText('No pipeline data in the last window.')).toHaveCount(0);
  });
});
