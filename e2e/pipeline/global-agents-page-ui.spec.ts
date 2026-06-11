import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// UI tests for the global /agents page (components/AgentsPage.tsx).
// Covers: loading skeleton, empty state, agent table with state pills,
// and filter tabs (All / Active / On-demand / Disabled).
// All HTTP calls are mocked — no real agents or projects needed.

const now = () => Math.floor(Date.now() / 1000);

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
  project: string;
  schedule: string | null;
  enabled: boolean;
  source: string;
  kind: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    project: 'test-project',
    skillIds: [],
    docPaths: [],
    model: 'claude-sonnet-4',
    prompt: 'Do the thing',
    schedule: null,
    enabled: true,
    boostable: true,
    provider: null,
    fallbackEnabled: false,
    prerequisiteCommand: null,
    permissionMode: null,
    createdAt: now() - 3600,
    updatedAt: now() - 3600,
    source: 'db',
    kind: 'user',
    cron: null,
    lastAttempt: null,
    ...overrides,
  };
}

function makeSchedulerEntry(agentId: string, overrides: Partial<{
  nextFireMs: number;
  lastFireMs: number | null;
  fireCount: number;
  errorCount: number;
  lastError: string | null;
}> = {}) {
  return {
    agentId,
    project: 'test-project',
    name: 'Test Agent',
    schedule: '0 * * * *',
    nextFireMs: Date.now() + 3_600_000,
    lastFireMs: null,
    fireCount: 5,
    errorCount: 0,
    lastError: null,
    ...overrides,
  };
}

async function stubShellRoutes(page: Page): Promise<void> {
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

test.describe('Global agents page UI', () => {
  // ---------------------------------------------------------------------------
  // Test 1: Loading skeleton is shown while agents are being fetched
  // ---------------------------------------------------------------------------
  test('shows loading skeleton while agents are in-flight', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: [] } } }),
    );

    // Hold the agents response until we explicitly release it.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route(
      (url) => url.pathname === '/api/agents',
      async (route: Route) => {
        await released;
        await route.fulfill({ json: { agents: [] } });
      },
    );

    await page.goto('/agents');

    // Skeleton should be visible while the fetch is in-flight.
    await expect(page.getByLabel('Loading agents')).toBeVisible({ timeout: 8_000 });

    // Release and confirm skeleton disappears.
    release();
    await expect(page.getByLabel('Loading agents')).not.toBeVisible({ timeout: 8_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Empty state when no agents exist
  // ---------------------------------------------------------------------------
  test('shows "No agents configured yet" when agents list is empty', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: [] } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents: [] } }),
    );

    await page.goto('/agents');

    await expect(page.getByText('No agents configured yet')).toBeVisible({ timeout: 8_000 });
    // Points operator toward next steps.
    await expect(page.getByText(/Agents appear here after they are created/)).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Table renders agents with correct state pills
  // ---------------------------------------------------------------------------
  test('renders agent table with active, on-demand, and disabled state pills', async ({ page }) => {
    const SCHEDULED_ID = 'agent-scheduled';
    const ON_DEMAND_ID = 'agent-on-demand';
    const DISABLED_ID = 'agent-disabled';

    const agents = [
      makeAgent({ id: SCHEDULED_ID, name: 'Scheduled Agent', schedule: '0 * * * *' }),
      makeAgent({ id: ON_DEMAND_ID, name: 'On-Demand Agent', schedule: null }),
      makeAgent({ id: DISABLED_ID, name: 'Disabled Agent', enabled: false }),
    ];
    // Scheduler health lists the scheduled agent as active (has a matching entry).
    const schedulerEntries = [makeSchedulerEntry(SCHEDULED_ID)];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: schedulerEntries } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    // All three rows rendered.
    await expect(page.getByText('Scheduled Agent')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('On-Demand Agent')).toBeVisible();
    await expect(page.getByText('Disabled Agent')).toBeVisible();

    // State pills — each unique text; locate the pill nearest the agent name.
    const scheduledRow = page.locator('tr', { hasText: 'Scheduled Agent' });
    const onDemandRow = page.locator('tr', { hasText: 'On-Demand Agent' });
    const disabledRow = page.locator('tr', { hasText: 'Disabled Agent' });

    await expect(scheduledRow.getByText('active', { exact: true })).toBeVisible();
    await expect(onDemandRow.getByText('on-demand', { exact: true })).toBeVisible();
    await expect(disabledRow.getByText('disabled', { exact: true })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 4: Filter tabs hide agents that don't match the selected filter
  // ---------------------------------------------------------------------------
  test('filter tabs show only matching agents', async ({ page }) => {
    const SCHEDULED_ID = 'agent-filter-scheduled';
    const ON_DEMAND_ID = 'agent-filter-on-demand';

    const agents = [
      makeAgent({ id: SCHEDULED_ID, name: 'Filter Scheduled', schedule: '0 * * * *' }),
      makeAgent({ id: ON_DEMAND_ID, name: 'Filter On-Demand', schedule: null }),
    ];
    const schedulerEntries = [makeSchedulerEntry(SCHEDULED_ID)];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: schedulerEntries } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    // Both visible on the All tab.
    await expect(page.getByText('Filter Scheduled')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Filter On-Demand')).toBeVisible();

    // The filter strip renders as a <nav aria-label="Agent filters"> with <button> items.
    const filterNav = page.getByRole('navigation', { name: 'Agent filters' });

    // Click the "Active" filter — shows only the scheduled agent.
    await filterNav.getByRole('button', { name: /Active/i }).click();
    await expect(page.getByText('Filter Scheduled')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('Filter On-Demand')).not.toBeVisible();

    // Click the "On-demand" filter — shows only the on-demand agent.
    await filterNav.getByRole('button', { name: /On-demand/i }).click();
    await expect(page.getByText('Filter On-Demand')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('Filter Scheduled')).not.toBeVisible();

    // Click "All" — both visible again.
    await filterNav.getByRole('button', { name: /^All/i }).click();
    await expect(page.getByText('Filter Scheduled')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('Filter On-Demand')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Scheduler error count shown in warning color
  // ---------------------------------------------------------------------------
  test('shows error count in warning color for agents with scheduler errors', async ({ page }) => {
    const ERRORING_ID = 'agent-errors';

    const agents = [makeAgent({ id: ERRORING_ID, name: 'Erroring Agent', schedule: '0 * * * *' })];
    const schedulerEntries = [
      makeSchedulerEntry(ERRORING_ID, { errorCount: 3, lastError: 'timeout' }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: schedulerEntries } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    await expect(page.getByText('Erroring Agent')).toBeVisible({ timeout: 8_000 });

    // The error count cell should display "3" with the warning color class.
    const errorCell = page.locator('td').filter({ hasText: '3' }).first();
    await expect(errorCell).toBeVisible();
    await expect(errorCell.locator('span')).toHaveClass(/text-status-warning/);
  });

  // ---------------------------------------------------------------------------
  // Test 6: An enabled scheduled agent with no scheduler entry shows the
  // "unscheduled" warning state — it has a schedule but is not registered in
  // the internal scheduler, which is the operator's signal that the cron did
  // not take effect. This is a distinct state from active/on-demand/disabled.
  // ---------------------------------------------------------------------------
  test('shows "unscheduled" warning state when a scheduled agent is not registered', async ({ page }) => {
    const UNREG_ID = 'agent-unscheduled';

    // Enabled + has a schedule, but the scheduler-health entries list is empty,
    // so agentState() resolves to "unscheduled".
    const agents = [makeAgent({ id: UNREG_ID, name: 'Unregistered Agent', schedule: '0 * * * *' })];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: [] } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    const row = page.locator('tr', { hasText: 'Unregistered Agent' });
    const pill = row.getByText('unscheduled', { exact: true });
    await expect(pill).toBeVisible({ timeout: 8_000 });
    // The pill carries a diagnostic title explaining the mismatch.
    await expect(pill).toHaveAttribute('title', /not registered in internal scheduler/i);

    // Filtering to "Active" excludes it (it is not active) and the empty-state
    // meta surfaces the count of enabled-but-unregistered agents.
    await page.getByRole('navigation', { name: 'Agent filters' })
      .getByRole('button', { name: /Active/i }).click();
    await expect(page.getByText('No active scheduled agents')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText(/not registered in the scheduler yet/i)).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 7: Scheduler-derived columns reflect entry state — an overdue next
  // fire renders "overdue" in warning tone, and an agent that has never fired
  // shows the "never fired" placeholder rather than a relative timestamp.
  // ---------------------------------------------------------------------------
  test('renders overdue next-fire and never-fired last-fire from scheduler entry', async ({ page }) => {
    const OVERDUE_ID = 'agent-overdue';

    const agents = [makeAgent({ id: OVERDUE_ID, name: 'Overdue Agent', schedule: '0 * * * *' })];
    const schedulerEntries = [
      makeSchedulerEntry(OVERDUE_ID, {
        // Well past the 30s overdue grace window, and never fired.
        nextFireMs: Date.now() - 120_000,
        lastFireMs: null,
        fireCount: 0,
      }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: schedulerEntries } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    const row = page.locator('tr', { hasText: 'Overdue Agent' });
    await expect(row).toBeVisible({ timeout: 8_000 });

    // Next Fire cell shows "overdue" in warning tone.
    const overdue = row.getByText('overdue', { exact: true });
    await expect(overdue).toBeVisible();
    await expect(overdue).toHaveClass(/text-status-warning/);

    // Last Fire cell shows the never-fired placeholder.
    await expect(row.getByText('never fired', { exact: true })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 8: Source/kind badges — a file-backed agent renders a "file" tag and a
  // built-in system agent renders a "system" tag with a diagnostic title. These
  // origin badges are distinct from the lifecycle state pill.
  // ---------------------------------------------------------------------------
  test('renders file and system origin badges next to the agent name', async ({ page }) => {
    const FILE_ID = 'agent-file';
    const SYSTEM_ID = 'agent-system';

    const agents = [
      makeAgent({ id: FILE_ID, name: 'File Agent', source: 'file', schedule: null }),
      makeAgent({ id: SYSTEM_ID, name: 'System Agent', kind: 'system', schedule: null }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: [] } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    const fileRow = page.locator('tr', { hasText: 'File Agent' });
    await expect(fileRow.getByText('file', { exact: true })).toBeVisible({ timeout: 8_000 });

    const systemRow = page.locator('tr', { hasText: 'System Agent' });
    const systemBadge = systemRow.getByText('system', { exact: true });
    await expect(systemBadge).toBeVisible();
    await expect(systemBadge).toHaveAttribute('title', /built-in system agent/i);
  });

  // ---------------------------------------------------------------------------
  // Test 9: A scheduled agent whose next fire is still in the future but has
  // accumulated scheduler errors shows the upcoming "in <time>" label in the
  // warning tone — the error count promotes the tone even though it is not
  // overdue, and the title surfaces the last error. This is a separate branch
  // from the overdue path covered in test 7.
  // ---------------------------------------------------------------------------
  test('shows future next-fire in warning tone when the agent has scheduler errors', async ({ page }) => {
    const ERR_ID = 'agent-future-errors';

    const agents = [makeAgent({ id: ERR_ID, name: 'Future Errors Agent', schedule: '0 * * * *' })];
    const schedulerEntries = [
      makeSchedulerEntry(ERR_ID, {
        // Comfortably in the future (not overdue) but carrying errors.
        nextFireMs: Date.now() + 1_800_000,
        errorCount: 2,
        lastError: 'boom',
      }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: schedulerEntries } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route: Route) => route.fulfill({ json: { agents } }),
    );

    await page.goto('/agents');

    const row = page.locator('tr', { hasText: 'Future Errors Agent' });
    await expect(row).toBeVisible({ timeout: 8_000 });

    // Next Fire shows an upcoming "in ..." label (not "overdue") in warning tone.
    const nextFire = row.getByText(/^in /);
    await expect(nextFire).toBeVisible();
    await expect(nextFire).toHaveClass(/text-status-warning/);
    await expect(row.getByText('overdue', { exact: true })).toHaveCount(0);
    // The hint surfaces the error detail rather than the fire schedule.
    await expect(nextFire).toHaveAttribute('title', /error\(s\): boom/i);
  });
});
