import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Recommendations card action UI tests — AUTO/MANUAL badges, Fix menu actions
// (Run agent now, Stop boosting, Run investigation, Decrease rate), notice banner,
// and orchestrator_agent_health / agent_unfruitful card rendering.
// All tests use page.route() mocking against port 1338; no real data writes.

const now = () => Math.floor(Date.now() / 1000);

type RecOverrides = Partial<{
  id: string;
  project: string;
  type: string;
  title: string;
  detail: string;
  agent_id: string | null;
  agent_name: string | null;
  payload: Record<string, unknown> | null;
}>;

function makeRec(overrides: RecOverrides = {}) {
  return {
    id: 'rec-1',
    project: 'my-project',
    source_kind: 'agent',
    source_id: null,
    agent_id: 'agent-abc',
    agent_name: 'my-agent',
    type: 'agent_schedule_backoff',
    title: 'Reduce run frequency',
    detail: 'Agent found no actionable work repeatedly.',
    status: 'open',
    payload: {
      recommendedSchedule: '0 */6 * * *',
      currentSchedule: '0 * * * *',
      enabled: true,
      boostable: true,
    },
    created_at: now() - 7200,
    updated_at: now() - 3600,
    ...overrides,
  };
}

async function stubShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
}

async function stubOpenRec(
  page: import('@playwright/test').Page,
  rec: ReturnType<typeof makeRec>,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
    (route: Route) => route.fulfill({ json: { recommendations: [rec] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
    (route: Route) => route.fulfill({ json: { recommendations: [] } }),
  );
}

// The Fix menu uses a <details><summary> element (not a <button>). Playwright's
// getByRole('button') may not match <summary> in all cases; use an attribute
// selector instead.
function fixMenuLocator(page: import('@playwright/test').Page) {
  return page.locator('[aria-label*="Fix recommendation"]');
}

test.describe('Recommendation card badges and Fix actions', () => {
  // ─── AUTO badge ─────────────────────────────────────────────────────────────
  test('orchestrator_boost shows AUTO badge (green) and no Fix menu', async ({ page }) => {
    const rec = makeRec({
      id: 'boost-1',
      type: 'orchestrator_boost',
      title: 'Boost fired',
      detail: 'Orchestrator dispatched an extra run.',
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('Boost fired')).toBeVisible({ timeout: 8_000 });

    // AUTO pill is visible (exact: true guards against substring matches)
    await expect(page.getByText('AUTO', { exact: true })).toBeVisible();
    // MANUAL pill must not appear
    await expect(page.getByText('MANUAL', { exact: true })).not.toBeVisible();

    // No Fix dropdown for AUTO recommendations
    await expect(fixMenuLocator(page)).not.toBeVisible();
  });

  // ─── MANUAL badge ────────────────────────────────────────────────────────────
  test('agent_unfruitful shows MANUAL badge (amber) and Fix menu', async ({ page }) => {
    const rec = makeRec({
      id: 'unfruitful-1',
      type: 'agent_unfruitful',
      title: 'Agent is unproductive',
      detail: 'Scheduled runs produce no file changes.',
      payload: { cause: 'unproductive', enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('Agent is unproductive')).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('MANUAL', { exact: true })).toBeVisible();
    await expect(page.getByText('AUTO', { exact: true })).not.toBeVisible();

    // Fix menu button is visible (MANUAL + has agent_id)
    await expect(fixMenuLocator(page)).toBeVisible();
  });

  test('agent_schedule_backoff shows MANUAL badge and Fix menu', async ({ page }) => {
    const rec = makeRec({
      id: 'backoff-1',
      type: 'agent_schedule_backoff',
      title: 'Consider slowing down',
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('Consider slowing down')).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('MANUAL', { exact: true })).toBeVisible();
    await expect(fixMenuLocator(page)).toBeVisible();
  });

  // ─── "Run agent now" → notice banner ─────────────────────────────────────────
  test('"Run agent now" fires POST and shows notice banner; X button dismisses it', async ({
    page,
  }) => {
    const rec = makeRec({
      id: 'health-1',
      type: 'orchestrator_agent_health',
      title: 'Loop detected',
      detail: 'Agent appears to be looping.',
      payload: { enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    let runCalled = false;
    await page.route(
      (url) => url.pathname === '/api/agents/agent-abc/run',
      (route: Route) => {
        if (route.request().method() === 'POST') {
          runCalled = true;
          route.fulfill({ json: { status: 'started', job_id: 'job-1', pid: 1234 } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('Loop detected')).toBeVisible({ timeout: 8_000 });

    // Open Fix dropdown (summary element — use attribute selector, not getByRole)
    await fixMenuLocator(page).click();
    await expect(page.getByRole('button', { name: 'Run agent now' })).toBeVisible({
      timeout: 4_000,
    });

    await page.getByRole('button', { name: 'Run agent now' }).click();

    // Notice banner appears
    await expect(
      page.getByText(/Triggered a run of my-agent in my-project/),
    ).toBeVisible({ timeout: 6_000 });
    expect(runCalled).toBe(true);

    // Dismissing notice with X clears it
    await page.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(page.getByText(/Triggered a run of/)).not.toBeVisible({ timeout: 4_000 });
  });

  // ─── "Stop boosting" Fix action ──────────────────────────────────────────────
  test('"Stop boosting" PATCHes agent and shows notice banner', async ({ page }) => {
    const rec = makeRec({
      id: 'boost-stop-1',
      type: 'agent_unfruitful',
      title: 'Unproductive agent',
      payload: { cause: 'unproductive', enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    let patchBody: unknown = null;
    await page.route(
      (url) => url.pathname === '/api/agents/agent-abc',
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          patchBody = route.request().postDataJSON();
          route.fulfill({
            json: {
              agent: {
                id: 'agent-abc',
                name: 'my-agent',
                project: 'my-project',
                boostable: false,
              },
            },
          });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('Unproductive agent')).toBeVisible({ timeout: 8_000 });

    // Open Fix dropdown
    await fixMenuLocator(page).click();
    await expect(page.getByRole('button', { name: 'Stop boosting' })).toBeVisible({
      timeout: 4_000,
    });

    await page.getByRole('button', { name: 'Stop boosting' }).click();

    // Notice banner appears
    await expect(
      page.getByText(/Stopped boost runs for my-agent in my-project/),
    ).toBeVisible({ timeout: 6_000 });

    expect(patchBody).toMatchObject({ boostable: false });
  });

  // ─── "Run investigation" Fix action ──────────────────────────────────────────
  test('"Run investigation" fires POST with readOnly flag and shows notice banner', async ({
    page,
  }) => {
    const rec = makeRec({
      id: 'inv-1',
      type: 'agent_unfruitful',
      title: 'No changes produced',
      payload: { cause: 'unproductive', enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    let postBody: unknown = null;
    await page.route(
      (url) => url.pathname === '/api/agents/agent-abc/run',
      (route: Route) => {
        if (route.request().method() === 'POST') {
          postBody = route.request().postDataJSON();
          route.fulfill({ json: { status: 'started', job_id: 'job-inv-1', pid: 4321 } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('No changes produced')).toBeVisible({ timeout: 8_000 });

    await fixMenuLocator(page).click();
    await expect(page.getByRole('button', { name: 'Run investigation' })).toBeVisible({
      timeout: 4_000,
    });

    await page.getByRole('button', { name: 'Run investigation' }).click();

    await expect(
      page.getByText(/Started a read-only investigation run of my-agent in my-project/),
    ).toBeVisible({ timeout: 6_000 });

    // Verify read-only flag was passed
    expect(postBody).toMatchObject({ readOnly: true });
  });

  // ─── orchestrator_agent_health reasoning rows ─────────────────────────────────
  test('orchestrator_agent_health card renders health reasoning rows', async ({ page }) => {
    const rec = makeRec({
      id: 'health-reasons-1',
      type: 'orchestrator_agent_health',
      title: 'Loop trend detected',
      detail: 'LLM flagged looping across recent runs.',
      payload: {
        concernType: 'loop',
        severity: 'high',
        runsAnalyzed: 3,
        lastRunScore: 12,
        avgRunScore: 18.6,
        enabled: true,
        boostable: true,
      },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('Loop trend detected')).toBeVisible({ timeout: 8_000 });

    // "Why" panel header is rendered
    await expect(page.getByText('Why', { exact: true })).toBeVisible();

    // dt labels (scoped to the dl element to avoid collisions)
    const dl = page.locator('dl');
    await expect(dl.locator('dt', { hasText: 'concern' })).toBeVisible();
    await expect(dl.locator('dt', { hasText: 'severity' })).toBeVisible();
    await expect(dl.locator('dt', { hasText: 'runs analyzed' })).toBeVisible();
    await expect(dl.locator('dt', { hasText: 'last score' })).toBeVisible();
    await expect(dl.locator('dt', { hasText: 'avg score' })).toBeVisible();

    // dd values (scoped to dl so nothing outside the panel can match)
    await expect(dl.locator('dd', { hasText: /^loop$/ })).toBeVisible();
    await expect(dl.locator('dd', { hasText: /^high$/ })).toBeVisible();
    await expect(dl.locator('dd', { hasText: '12/100' })).toBeVisible();
    await expect(dl.locator('dd', { hasText: '19/100' })).toBeVisible(); // Math.round(18.6)
  });

  // ─── agent_unfruitful + cause=unproductive → "Improve prompt" link ───────────
  test('agent_unfruitful with cause=unproductive shows Improve prompt in Fix menu', async ({
    page,
  }) => {
    const rec = makeRec({
      id: 'unfruitful-productive-1',
      type: 'agent_unfruitful',
      title: 'Prompt too narrow',
      payload: { cause: 'unproductive', enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('Prompt too narrow')).toBeVisible({ timeout: 8_000 });

    await fixMenuLocator(page).click();

    // "Improve prompt" link appears only for unproductive cause
    const improveLink = page.getByRole('link', { name: 'Improve prompt' });
    await expect(improveLink).toBeVisible({ timeout: 4_000 });

    // Verify it deep-links to the editor with improve=1
    const href = await improveLink.getAttribute('href');
    expect(href).toContain('improve=1');
    expect(href).toContain('agent-abc');
  });

  // ─── agent_unfruitful + cause=idle → NO "Improve prompt" ────────────────────
  test('agent_unfruitful with cause=idle does NOT show Improve prompt in Fix menu', async ({
    page,
  }) => {
    const rec = makeRec({
      id: 'unfruitful-idle-1',
      type: 'agent_unfruitful',
      title: 'No actionable work found',
      payload: { cause: 'idle', enabled: true, boostable: true },
    });

    await stubShellRoutes(page);
    await stubOpenRec(page, rec);

    await page.goto('/recommendations');
    await expect(page.getByText('No actionable work found')).toBeVisible({ timeout: 8_000 });

    await fixMenuLocator(page).click();

    // Fix menu is open — Stop boosting is visible but "Improve prompt" must not appear
    await expect(page.getByRole('button', { name: 'Stop boosting' })).toBeVisible({
      timeout: 4_000,
    });
    await expect(page.getByRole('link', { name: 'Improve prompt' })).not.toBeVisible();
  });
});
