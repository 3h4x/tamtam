import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'
import { PROJECT, mockProjectShell, releasePushFailureJobs } from './pipeline-strip-fixtures'

test.describe('PipelineStrip visibility', () => {
  test('terminal tab surfaces push failure details during recovery', async ({ page }) => {
    await mockProjectShell(page, releasePushFailureJobs(), {
      lastPushError: 'Push failed: remote rejected: protected branch',
    })
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('Push failed: remote rejected: protected branch')).toBeVisible()
    await expect(page.getByTitle('fix in progress — click to open terminal')).toBeVisible()

    const retryRequest = page.waitForRequest((request) =>
      request.method() === 'POST' &&
      request.url().endsWith(`/api/projects/by-project/${PROJECT}/push`) &&
      request.postDataJSON()?.release_id === 'strip-push-fail-release',
    )
    await page.getByRole('button', { name: 'retry push' }).click()
    await retryRequest
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal\\?job=strip-push-retry$`))
  })

  test('retry push affordance is disabled with a paused hint while jobs are globally paused', async ({
    page,
  }) => {
    await mockProjectShell(page, releasePushFailureJobs(), {
      lastPushError: 'Push failed: remote rejected: protected branch',
    })
    // Override the shell's default jobs_paused=false so the strip receives the
    // paused gate. The most recently registered route wins in Playwright.
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({ json: { settings: { jobs_paused: 'true' }, github_owner: '' } }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel(/push: failed\./i)).toBeVisible()

    const retryBtn = page.getByRole('button', { name: 'retry push' })
    await expect(retryBtn).toBeVisible()
    await expect(retryBtn).toBeDisabled()
    await expect(retryBtn).toHaveAttribute(
      'title',
      /jobs are paused globally\. resume jobs to start a push\./i,
    )

    // The disabled affordance must not be able to fire a push request.
    let pushRequested = false
    await page.route(`**/api/projects/by-project/${PROJECT}/push`, (route: Route) => {
      pushRequested = true
      route.fulfill({ json: { job_id: 'should-not-happen' } })
    })
    await retryBtn.click({ force: true }).catch(() => {})
    await expect(retryBtn).toBeDisabled()
    expect(pushRequested).toBe(false)
  })

  test('retry push affordance re-enables in place when jobs are unpaused via poll', async ({
    page,
  }) => {
    let paused = true
    await mockProjectShell(page, releasePushFailureJobs(), {
      lastPushError: 'Push failed: remote rejected: protected branch',
    })
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({
        json: { settings: { jobs_paused: paused ? 'true' : 'false' }, github_owner: '' },
      }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    const retryBtn = page.getByRole('button', { name: 'retry push' })
    await expect(retryBtn).toBeVisible({ timeout: 8_000 })
    await expect(retryBtn).toBeDisabled()
    await expect(retryBtn).toHaveAttribute(
      'title',
      /jobs are paused globally\. resume jobs to start a push\./i,
    )

    paused = false

    await expect(retryBtn).toBeEnabled({ timeout: 12_000 })
    await expect(retryBtn).toHaveAttribute('title', /^retry push$/i)
  })
})
