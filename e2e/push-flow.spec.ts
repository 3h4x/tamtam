import { test, expect, Route } from '@playwright/test';

// E2E coverage for the SmartPushModal push flow on the projects list page.
// All HTTP calls are mocked — no real git invocations.
//
// Rules under test:
//  1. Full happy path: preview → generate → select → execute → done
//  2. Push succeeds when behind remote (auto-rebase is transparent to the UI)
//  3. Rebase conflict (409) shows clean error — no raw hint:/fatal: text
//  4. Generic push error shows clean error — no raw hint:/fatal: text
//  5. Error state offers Retry that returns to preview

const PROJECT = 'pushtest';

interface PushScenario {
  totalChanges?: number;
  previewResponse?: { status: number; body: Record<string, unknown> };
  generateResponse?: { status: number; body: Record<string, unknown> };
  executeResponse?: { status: number; body: Record<string, unknown> };
}

async function mockPush(page: import('@playwright/test').Page, s: PushScenario) {
  const changes = s.totalChanges ?? 2;

  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [{
          project: PROJECT,
          path: `/tmp/${PROJECT}`,
          github: null,
          priority: null,
          changes,
          reviewed: false,
          unpushed: 0,
          last_run_ago: null,
          release_tag: null,
        }],
      },
    });
  });

  await page.route('**/api/jobs', (route: Route) => {
    route.fulfill({ json: { jobs: [] } });
  });
  await page.route('**/api/jobs/notifications', (route: Route) => {
    route.fulfill({ json: { jobs: [] } });
  });

  const previewResp = s.previewResponse ?? {
    status: 200,
    body: {
      files: [
        { filename: 'src/index.ts', status: 'M', stats: '+10 -2' },
        { filename: 'src/lib.ts', status: 'A', stats: '+25 -0' },
      ],
      summary: '2 files changed',
    },
  };
  await page.route(`**/api/projects/by-project/${PROJECT}/push/preview`, (route: Route) => {
    route.fulfill({ status: previewResp.status, json: previewResp.body });
  });

  const generateResp = s.generateResponse ?? {
    status: 200,
    body: { options: ['feat: add new module', 'chore: update src'], model: 'haiku' },
  };
  await page.route(`**/api/projects/by-project/${PROJECT}/push/generate`, (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: generateResp.status, json: generateResp.body });
    }
    route.fulfill({ status: 404, json: { detail: 'not found' } });
  });

  const executeResp = s.executeResponse ?? {
    status: 200,
    body: { status: 'success', message: 'Changes pushed successfully', commit_sha: 'abc1234' },
  };
  await page.route(`**/api/projects/by-project/${PROJECT}/push/execute`, (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: executeResp.status, json: executeResp.body });
    }
    route.fulfill({ status: 404, json: { detail: 'not found' } });
  });
}

async function openPushModal(page: import('@playwright/test').Page) {
  await page.goto('/');
  const pushBtn = page.getByRole('button', { name: /^push$/i }).first();
  await expect(pushBtn).toBeVisible();
  await pushBtn.click();
  // Modal header should appear
  await expect(page.getByRole('heading', { name: new RegExp(PROJECT, 'i') })).toBeVisible();
}

// ─── Happy path ────────────────────────────────────────────────────────────────

test('full push flow: preview → generate → select → execute → done', async ({ page }) => {
  await mockPush(page, {});
  await openPushModal(page);

  // Preview step: files visible
  await expect(page.locator('text=src/index.ts')).toBeVisible();
  await expect(page.locator('text=src/lib.ts')).toBeVisible();

  // Click Generate Commit Messages
  await page.getByRole('button', { name: /generate commit messages/i }).click();

  // Select step: options visible
  await expect(page.locator('text=feat: add new module')).toBeVisible();
  await expect(page.locator('text=chore: update src')).toBeVisible();

  // Click Commit & Push with first option selected by default
  await page.getByRole('button', { name: /commit & push/i }).click();

  // Done step: success message
  await expect(page.locator('text=Pushed successfully')).toBeVisible();
  await expect(page.locator('text=abc1234')).toBeVisible();
});

// ─── Behind remote (auto-rebase transparent to UI) ────────────────────────────

test('push succeeds when behind remote (auto-rebase handled server-side)', async ({ page }) => {
  await mockPush(page, {
    // Server rebases and pushes successfully — execute returns 200 just like normal
    executeResponse: { status: 200, body: { status: 'success', message: 'Changes pushed successfully', commit_sha: 'def5678' } },
  });
  await openPushModal(page);
  await page.getByRole('button', { name: /generate commit messages/i }).click();
  await expect(page.locator('text=feat: add new module')).toBeVisible();
  await page.getByRole('button', { name: /commit & push/i }).click();

  await expect(page.locator('text=Pushed successfully')).toBeVisible();
  await expect(page.locator('text=def5678')).toBeVisible();
  // No hint/fatal text should appear
  await expect(page.locator('text=/hint:/i')).toHaveCount(0);
  await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
});

// ─── Rebase conflict (409) ─────────────────────────────────────────────────────

test('shows clean error on rebase conflict — no raw hint/fatal text', async ({ page }) => {
  await mockPush(page, {
    executeResponse: { status: 409, body: { detail: 'Rebase failed: CONFLICT in src/index.ts' } },
  });
  await openPushModal(page);
  await page.getByRole('button', { name: /generate commit messages/i }).click();
  await expect(page.locator('text=feat: add new module')).toBeVisible();
  await page.getByRole('button', { name: /commit & push/i }).click();

  // Error step: clean user-facing message
  await expect(page.locator('text=/Rebase failed/i')).toBeVisible();

  // No raw git noise
  await expect(page.locator('text=/hint:/i')).toHaveCount(0);
  await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
});

// ─── Generic push error ────────────────────────────────────────────────────────

test('shows clean error on push failure — no raw hint/fatal text', async ({ page }) => {
  await mockPush(page, {
    executeResponse: { status: 400, body: { detail: 'Push failed: remote rejected' } },
  });
  await openPushModal(page);
  await page.getByRole('button', { name: /generate commit messages/i }).click();
  await page.getByRole('button', { name: /commit & push/i }).click();

  await expect(page.locator('text=/Push failed/i')).toBeVisible();
  await expect(page.locator('text=/hint:/i')).toHaveCount(0);
  await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
});

// ─── Retry from error ─────────────────────────────────────────────────────────

test('Retry button from error state returns to preview', async ({ page }) => {
  await mockPush(page, {
    executeResponse: { status: 400, body: { detail: 'Push failed: connection timeout' } },
  });
  await openPushModal(page);
  await page.getByRole('button', { name: /generate commit messages/i }).click();
  await page.getByRole('button', { name: /commit & push/i }).click();

  await expect(page.locator('text=/Push failed/i')).toBeVisible();

  // Click Retry — should go back to preview with files visible
  await page.getByRole('button', { name: /retry/i }).click();
  await expect(page.locator('text=src/index.ts')).toBeVisible();
  await expect(page.getByRole('button', { name: /generate commit messages/i })).toBeVisible();
});

// ─── Preview error ─────────────────────────────────────────────────────────────

test('shows error cleanly when preview fails', async ({ page }) => {
  await mockPush(page, {
    previewResponse: { status: 500, body: { detail: 'git add failed: permission denied' } },
  });
  await openPushModal(page);

  // The modal should show error state
  await expect(page.locator('text=/permission denied/i')).toBeVisible();
  await expect(page.locator('text=/hint:/i')).toHaveCount(0);
  await expect(page.locator('text=/fatal:/i')).toHaveCount(0);
});
