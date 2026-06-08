import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Release trace page retry UI test — verifies that a transient load failure of
// /project/<name>/release/<releaseId> surfaces a Retry control that recovers
// in place (no navigation, no full page reload). Uses page.route() for all
// API mocking; no real pipeline execution involved.

const PROJECT = 'trace-retry-ui';
const RELEASE_ID = 'rel-retry-001';
const now = () => Math.floor(Date.now() / 1000);

interface MockTrace {
  release_id: string;
  project: string;
  branch: string | null;
  status: 'running' | 'done' | 'aborted';
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  trigger: null;
  steps: Array<{
    job_id: string;
    kind: string;
    status: 'running' | 'done' | 'aborted';
    exit_code: number | null;
    started_at: number;
    finished_at: number | null;
    duration_ms: number | null;
    verdict: string | null;
    log_excerpt: string;
  }>;
}

function successTrace(): MockTrace {
  return {
    release_id: RELEASE_ID,
    project: PROJECT,
    branch: 'master',
    status: 'done',
    started_at: now() - 120,
    finished_at: now() - 10,
    exit_code: 0,
    trigger: null,
    steps: [
      {
        job_id: 'step-review-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 80,
        finished_at: now() - 50,
        duration_ms: 30000,
        verdict: 'LGTM',
        log_excerpt: '',
      },
      {
        job_id: 'step-push-1',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 45,
        finished_at: now() - 10,
        duration_ms: 35000,
        verdict: null,
        log_excerpt: '',
      },
    ],
  };
}

async function stubShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
}

test.describe('Release trace retry', () => {
  test('transient release trace load failure can be retried without navigation', async ({
    page,
  }) => {
    let shouldFail = true;

    await stubShell(page);
    await page.route(
      `**/api/projects/by-project/${PROJECT}/release/${RELEASE_ID}`,
      (route: Route) => {
        if (shouldFail) {
          route.fulfill({ status: 500, json: { error: 'temporary backend failure' } });
          return;
        }
        route.fulfill({ json: successTrace() });
      },
    );

    await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

    // Initial load fails — the error panel and a Retry control must appear.
    await expect(page.getByText('Error 500')).toBeVisible({ timeout: 8_000 });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    const stableUrl = page.url();

    // Backend recovers; clicking Retry reloads in place.
    shouldFail = false;
    await retry.click();

    await expect(page.getByText('success')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('LGTM')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Error 500')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });
});
