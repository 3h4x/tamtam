import { test, expect, Route } from '@playwright/test';

// E2E coverage for the Pull button behaviour in the project header and Changes tab.
// All HTTP calls are mocked — no real git invocations.
//
// Rules under test:
//  1. Pull button is disabled + shows tooltip when local changes exist
//  2. Pull button is enabled + yellow when behind remote and no local changes
//  3. Pull button is plain (enabled) when up-to-date and no local changes
//  4. Changes-tab Pull button follows the same disable-when-dirty rule
//  5. Diverged error shows Rebase/Merge choice instead of raw git text

const PROJECT = 'pulltest';

interface PullScenario {
  totalChanges: number;
  behind: number;
  ahead?: number;
  changeFiles?: Array<{ status: string; filename: string; additions: number; deletions: number; binary: boolean }>;
  pullResponse?: { status: number; body: Record<string, unknown> };
  onPullPost?: () => void;
}

async function mockPull(page: import('@playwright/test').Page, s: PullScenario) {
  const files = s.changeFiles ?? [];

  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [{
          project: PROJECT,
          path: `/tmp/${PROJECT}`,
          github: null,
          priority: null,
          changes: s.totalChanges,
          reviewed: false,
          unpushed: 0,
          last_run_ago: null,
          release_tag: null,
        }],
      },
    });
  });

  await page.route(`**/api/jobs?project=${PROJECT}`, (route: Route) => {
    route.fulfill({ json: { jobs: [] } });
  });
  await page.route('**/api/jobs', (route: Route) => {
    route.fulfill({ json: { jobs: [] } });
  });
  await page.route('**/api/jobs/notifications', (route: Route) => {
    route.fulfill({ json: { jobs: [] } });
  });

  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) => {
    route.fulfill({
      json: {
        project: PROJECT, test_command: '', detected_test_command: '',
        effective_test_command: '', test_cron_enabled: false,
        test_cron_schedule: '', auto_push_enabled: false,
        last_push_error: null, last_push_at: null,
      },
    });
  });

  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) => {
    route.fulfill({ json: { actions: [] } });
  });

  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) => {
    route.fulfill({ json: { agents: [] } });
  });

  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) => {
    route.fulfill({ json: { behind: s.behind, ahead: s.ahead ?? 0 } });
  });

  await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
    if (route.request().method() === 'POST') {
      s.onPullPost?.();
      const resp = s.pullResponse ?? { status: 200, body: { status: 'ok', output: 'Already up to date.' } };
      return route.fulfill({ status: resp.status, json: resp.body });
    }
    route.fulfill({
      json: {
        files,
        totalFiles: files.length,
        totalAdditions: files.reduce((n, f) => n + f.additions, 0),
        totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
        branch: 'master',
        behind: s.behind,
        ahead: s.ahead ?? 0,
      },
    });
  });

  await page.route('**/api/streaming/**', (route: Route) => {
    route.fulfill({ status: 204, body: '' });
  });
}

// ─── Header Pull button ────────────────────────────────────────────────────

test.describe('Header Pull button', () => {
  test('is disabled with tooltip when local changes exist', async ({ page }) => {
    await mockPull(page, {
      totalChanges: 2,
      behind: 1,
      changeFiles: [
        { status: 'M', filename: 'src/a.ts', additions: 10, deletions: 2, binary: false },
        { status: 'M', filename: 'src/b.ts', additions: 5, deletions: 1, binary: false },
      ],
    });
    await page.goto(`/project/${PROJECT}`);

    const pullBtn = page.getByRole('button', { name: /pull/i }).first();
    await expect(pullBtn).toBeDisabled();
    const title = await pullBtn.getAttribute('title');
    expect(title).toMatch(/commit or stash/i);
    expect(title).toMatch(/2 local change/i);
  });

  test('is yellow and enabled when behind remote with no local changes', async ({ page }) => {
    await mockPull(page, { totalChanges: 0, behind: 3 });
    await page.goto(`/project/${PROJECT}`);

    const pullBtn = page.getByRole('button', { name: /pull \(3\)/i });
    await expect(pullBtn).toBeEnabled();
    const title = await pullBtn.getAttribute('title');
    expect(title).toMatch(/3 commit/i);
    expect(title).toMatch(/behind/i);
  });

  test('is plain and enabled when up-to-date with no local changes', async ({ page }) => {
    await mockPull(page, { totalChanges: 0, behind: 0 });
    await page.goto(`/project/${PROJECT}`);

    const pullBtn = page.getByRole('button', { name: /^pull$/i });
    await expect(pullBtn).toBeEnabled();
  });

  test('does not fire POST when disabled due to local changes', async ({ page }) => {
    let postFired = false;
    await mockPull(page, {
      totalChanges: 1,
      behind: 1,
      changeFiles: [{ status: 'M', filename: 'x.ts', additions: 1, deletions: 0, binary: false }],
      onPullPost: () => { postFired = true; },
    });
    await page.goto(`/project/${PROJECT}`);

    const pullBtn = page.getByRole('button', { name: /pull/i }).first();
    await expect(pullBtn).toBeDisabled();
    // Clicking a disabled button should be a no-op
    await pullBtn.dispatchEvent('click');
    await page.waitForTimeout(300);
    expect(postFired).toBe(false);
  });

  test('shows Rebase/Merge when branches have diverged', async ({ page }) => {
    await mockPull(page, {
      totalChanges: 0,
      behind: 1,
      pullResponse: { status: 409, body: { detail: 'diverged', diverged: true } },
    });
    await page.goto(`/project/${PROJECT}`);

    const pullBtn = page.getByRole('button', { name: /pull/i }).first();
    await pullBtn.click();

    await expect(page.getByRole('button', { name: /rebase/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /merge/i })).toBeVisible();
  });
});

// ─── Changes tab Pull button ───────────────────────────────────────────────

test.describe('Changes tab Pull button', () => {
  test('is disabled with tooltip when local changes exist', async ({ page }) => {
    await mockPull(page, {
      totalChanges: 2,
      behind: 1,
      changeFiles: [
        { status: 'M', filename: 'src/a.ts', additions: 3, deletions: 1, binary: false },
        { status: 'A', filename: 'src/c.ts', additions: 7, deletions: 0, binary: false },
      ],
    });
    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByRole('button', { name: /^pull$/i });
    await expect(pullBtn).toBeVisible();
    await expect(pullBtn).toBeDisabled();
    const title = await pullBtn.getAttribute('title');
    expect(title).toMatch(/commit or stash/i);
    expect(title).toMatch(/2 local change/i);
  });

  test('is enabled when behind remote with no local changes', async ({ page }) => {
    await mockPull(page, { totalChanges: 0, behind: 2 });
    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByRole('button', { name: /^pull$/i });
    await expect(pullBtn).toBeVisible();
    await expect(pullBtn).toBeEnabled();
    const title = await pullBtn.getAttribute('title');
    expect(title).toMatch(/git pull --ff-only/i);
  });

  test('shows Rebase/Merge when diverged', async ({ page }) => {
    await mockPull(page, {
      totalChanges: 0,
      behind: 1,
      pullResponse: { status: 409, body: { detail: 'diverged', diverged: true } },
    });
    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByRole('button', { name: /^pull$/i });
    await pullBtn.click();

    await expect(page.getByRole('button', { name: /rebase/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /merge/i })).toBeVisible();
    // Raw git error text must not appear
    await expect(page.locator('text=/hint:/i')).toHaveCount(0);
    await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
  });

  test('raw git hint text never appears on pull error', async ({ page }) => {
    await mockPull(page, {
      totalChanges: 0,
      behind: 1,
      pullResponse: { status: 422, body: { detail: 'Something went wrong' } },
    });
    await page.goto(`/project/${PROJECT}/changes`);

    await page.getByRole('button', { name: /^pull$/i }).click();

    await expect(page.locator('text=/hint:/i')).toHaveCount(0);
    await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
  });
});
