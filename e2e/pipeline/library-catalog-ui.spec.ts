import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Library page UI tests — verify the agent catalog list and skills tab using
// mocked API responses. No real pipeline execution involved.

type CatalogEntry = {
  name: string;
  aliases: string[];
  description: string;
  dispatch: 'cli' | 'internal';
  defaultSchedule: string;
  defaultModel: string;
  prompt: string;
  skillIds: string[];
  autoSeed: boolean;
  tier: 'essential' | 'featured' | 'recommended' | null;
  fallbackEnabled: boolean;
  inspiration: Array<{ label: string; url: string }>;
  requires: string[];
  outputs: string[];
  relatedAgents: string[];
  version: string | null;
  prerequisiteCommand: string | null;
};

function makeEntry(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, 'name'>): CatalogEntry {
  return {
    aliases: [],
    description: `${overrides.name} agent description`,
    dispatch: 'cli',
    defaultSchedule: '',
    defaultModel: 'claude-sonnet-4',
    prompt: '',
    skillIds: [],
    autoSeed: false,
    tier: null,
    fallbackEnabled: false,
    inspiration: [],
    requires: [],
    outputs: [],
    relatedAgents: [],
    version: null,
    prerequisiteCommand: null,
    ...overrides,
  };
}

async function stubShellRoutes(
  page: import('@playwright/test').Page,
  catalogEntries: CatalogEntry[],
): Promise<void> {
  await page.route('**/api/agent-catalog', (route: Route) =>
    route.fulfill({ json: { entries: catalogEntries } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/skills**', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await page.route('**/api/personas**', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await page.route('**/api/usage/quota**', (route: Route) =>
    route.fulfill({
      json: {
        gateEnabled: false,
        fiveHour: { utilization: 0, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: [],
          meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
        },
      }),
  );
}

test.describe('Library page — agent catalog', () => {
  // -------------------------------------------------------------------------
  // Catalog loads and renders entries grouped by tier
  // -------------------------------------------------------------------------
  test('renders agent catalog entries with dispatch badges and skill pills', async ({ page }) => {
    const entries = [
      makeEntry({ name: 'code-reviewer', dispatch: 'internal', tier: 'essential', autoSeed: true, skillIds: ['code-review'] }),
      makeEntry({ name: 'deploy-agent', dispatch: 'cli', tier: 'featured', skillIds: [] }),
    ];
    await stubShellRoutes(page, entries);
    await page.goto('/library');

    // Catalog should display both agents
    await expect(page.getByText('code-reviewer', { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('deploy-agent', { exact: true })).toBeVisible({ timeout: 8_000 });

    // Internal dispatch shows "system" pill; CLI shows "cli" pill
    await expect(page.getByText('system').first()).toBeVisible();
    await expect(page.getByText('cli').first()).toBeVisible();

    // Skill pill is rendered for agents with skillIds (exact title match)
    await expect(page.getByTitle('code-review', { exact: true })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Auto-seeded entries group separately from tiered entries
  // -------------------------------------------------------------------------
  test('groups auto-seeded agents under "Auto-seeded (system)" heading', async ({ page }) => {
    const entries = [
      makeEntry({ name: 'auto-agent', dispatch: 'internal', autoSeed: true }),
      makeEntry({ name: 'cli-agent', dispatch: 'cli', tier: 'recommended', autoSeed: false }),
    ];
    await stubShellRoutes(page, entries);
    await page.goto('/library');

    await expect(page.getByText(/auto-seeded \(system\)/i)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('auto-agent', { exact: true })).toBeVisible();
    await expect(page.getByText('cli-agent', { exact: true })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Search filters catalog entries
  // -------------------------------------------------------------------------
  test('search input narrows visible entries to matching names', async ({ page }) => {
    const entries = [
      makeEntry({ name: 'security-auditor', description: 'Audits code for security issues' }),
      makeEntry({ name: 'frontend-dev', description: 'Builds frontend components' }),
    ];
    await stubShellRoutes(page, entries);
    await page.goto('/library');

    await expect(page.getByText('security-auditor')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('frontend-dev')).toBeVisible();

    // Type a query that only matches one agent
    await page.getByRole('searchbox', { name: /search agent catalog/i }).fill('security');

    await expect(page.getByText('security-auditor')).toBeVisible();
    await expect(page.getByText('frontend-dev')).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Search produces empty state when no entries match
  // -------------------------------------------------------------------------
  test('search that matches nothing shows "No agents match current search" empty state', async ({ page }) => {
    const entries = [
      makeEntry({ name: 'review-agent', description: 'Reviews code changes' }),
    ];
    await stubShellRoutes(page, entries);
    await page.goto('/library');

    await expect(page.getByText('review-agent')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('searchbox', { name: /search agent catalog/i }).fill('zzznomatch');

    await expect(page.getByText(/no agents match current search/i)).toBeVisible();
    await expect(page.getByText('review-agent')).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Count label updates as search filters entries
  // -------------------------------------------------------------------------
  test('count label reflects filtered vs total after search', async ({ page }) => {
    const entries = [
      makeEntry({ name: 'agent-alpha' }),
      makeEntry({ name: 'agent-beta' }),
      makeEntry({ name: 'agent-gamma' }),
    ];
    await stubShellRoutes(page, entries);
    await page.goto('/library');

    // Initially all 3 visible
    await expect(page.getByText('3 of 3')).toBeVisible({ timeout: 8_000 });

    // Search narrows to one match
    await page.getByRole('searchbox', { name: /search agent catalog/i }).fill('alpha');
    await expect(page.getByText('1 of 3')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Tab switch to Skills tab
  // -------------------------------------------------------------------------
  test('switching to the Skills tab shows the skills section', async ({ page }) => {
    await stubShellRoutes(page, [makeEntry({ name: 'some-agent' })]);
    await page.goto('/library');

    // Start on agents tab
    await expect(page.getByText('some-agent', { exact: true })).toBeVisible({ timeout: 8_000 });

    // Switch to skills tab (tabs use 'navigation' variant — no role="tab", just buttons)
    await page.getByRole('button', { name: 'Skills' }).click();

    // Agent catalog should be hidden; page description updates for skills
    await expect(page.getByText('some-agent', { exact: true })).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Empty catalog shows empty state (not loading spinner)
  // -------------------------------------------------------------------------
  test('empty catalog shows "No agent catalog entries yet" empty state', async ({ page }) => {
    await stubShellRoutes(page, []);
    await page.goto('/library');

    await expect(page.getByText(/no agent catalog entries yet/i)).toBeVisible({ timeout: 8_000 });
  });
});
