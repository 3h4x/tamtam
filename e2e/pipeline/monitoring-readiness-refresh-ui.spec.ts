import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const BASE_TIME = Date.parse('2026-06-11T10:00:00.000Z')

function monitoringData() {
  return {
    prometheus: { status: 'ok', alerts: [], services: [] },
    loki: { status: 'ok', errors: [], warnings: [] },
    notificationThrottle: { windowSeconds: 300, overrides: {}, suppressedTotal: 0, entries: [] },
    retention: {
      policy: { logRetentionCount: 200, logRetentionDays: 30, jobRowRetentionDays: 180 },
      lastProjectLogCleanup: null,
      lastNightlyCleanup: null,
    },
    hasIssues: false,
    fetchedAt: BASE_TIME,
    windowMs: 15 * 60 * 1000,
    config: { prometheusUrl: 'http://localhost:9090', lokiUrl: 'http://localhost:3100' },
  }
}

async function stubShellApis(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: monitoringData() }),
  )
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: { files: [], entries: [], fetchedAt: BASE_TIME } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({
      json: {
        ok: true,
        expected: [],
        actual: { graphile: [] },
        missing: [],
        orphans: { graphile: [] },
        errors: [],
        internal: { started: true, entries: [] },
      },
    }),
  )
}

test.describe('Monitoring readiness refresh UI', () => {
  test('manual Refresh updates the readiness panel without a page reload', async ({ page }) => {
    await stubShellApis(page)

    let healthy = false
    await page.route(
      (url) => url.pathname === '/api/health',
      (route: Route) =>
        route.fulfill({
          json: healthy
            ? {
                status: 'ok',
                ok: true,
                checks: [{ name: 'database', ok: true, severity: 'info', message: 'database reachable' }],
              }
            : {
                status: 'degraded',
                ok: false,
                checks: [{ name: 'database', ok: false, severity: 'error', message: 'database offline' }],
              },
        }),
    )

    await page.goto('/monitoring')

    await expect(page.getByText('Readiness checks')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('One or more checks need attention')).toBeVisible()
    await expect(page.getByText('database offline')).toBeVisible()
    await expect(page.getByText('degraded')).toBeVisible()

    healthy = true
    const readinessRefresh = page.waitForResponse((response) =>
      response.url().includes('/api/health?deep=1') && response.ok(),
    )
    await page.getByRole('button', { name: 'Refresh' }).click()
    await readinessRefresh

    await expect(page.getByText('Required local dependencies are available')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('database reachable')).toBeVisible()
    await expect(page.getByText('pass')).toBeVisible()
    await expect(page.getByText('database offline')).toHaveCount(0)
  })
})
