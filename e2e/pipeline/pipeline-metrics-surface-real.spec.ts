import { test, expect } from '@playwright/test';
import {
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

const SCENARIO = [
  {
    label: 'review',
    text: 'The implementation is clean and safe to ship.\n\nVerdict: LGTM',
  },
  { label: 'commit-message', text: 'feat: pipeline metrics surface' },
];

test.describe('Real pipeline metrics surface', () => {
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
});
