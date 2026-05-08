import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForJobCompletion,
} from './helpers'

const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
)

const PAUSED_PROJECT = 'paused'
const BUSY_PROJECT = 'abort'

test.describe('Real release controls lifecycle', () => {
  test.afterEach(async ({ request }) => {
    await request.patch('/api/settings', { data: { jobs_paused: false } })
  })

  test('release button reflects the real jobs_paused state and re-enables after resuming from the header toggle', async ({
    page,
    request,
  }) => {
    await enableProject(request, PAUSED_PROJECT, { testsDisabled: true })
    await request.patch('/api/settings', { data: { jobs_paused: true } })

    await page.goto(`/project/${PAUSED_PROJECT}`)

    const releaseButton = page.getByRole('button', { name: /release/i }).first()
    const pauseToggle = page.getByRole('switch', { name: /jobs paused/i })

    await expect(releaseButton).toBeVisible({ timeout: 8_000 })
    await expect(releaseButton).toBeDisabled()
    await expect(releaseButton).toHaveAttribute('title', /jobs are paused globally/i)
    await expect(pauseToggle).toHaveAttribute('aria-checked', 'true')

    await pauseToggle.click()

    await expect(page.getByRole('switch', { name: /pause jobs/i })).toBeVisible({ timeout: 8_000 })
    await expect(releaseButton).toBeEnabled()
    await expect(releaseButton).not.toHaveAttribute('title', /jobs are paused globally/i)
  })

  test('release button shows the real busy state during a live release and resets after abort without reload', async ({
    page,
    request,
  }) => {
    writeScenario(BUSY_PROJECT, ABORT_SCENARIO.steps)
    resetShimState(BUSY_PROJECT)
    await enableProject(request, BUSY_PROJECT, { testsDisabled: true })

    const releaseResponse = await request.post(`/api/projects/by-project/${BUSY_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const releaseBody = await releaseResponse.json() as { release_job_id: string }
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy()

    const runningReview = await waitForJobRunning(request, BUSY_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await page.goto(`/project/${BUSY_PROJECT}`)

    const busyButton = page.getByRole('button', { name: /releasing/i })
    await expect(busyButton).toBeVisible({ timeout: 8_000 })
    await expect(busyButton).toBeDisabled()
    await expect(busyButton).toHaveAttribute('title', /release pipeline already running/i)

    const abortResponse = await request.post(`/api/projects/by-project/${BUSY_PROJECT}/release/abort`)
    expect(abortResponse.status()).toBe(200)

    const finishedRelease = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000)
    expect(finishedRelease, 'release job should finish after abort').not.toBeNull()
    expect(finishedRelease?.['exit_code'], 'release exit code after abort').toBe(-3)

    const idleButton = page.getByRole('button', { name: '🚀 Release' })
    await expect(idleButton).toBeVisible({ timeout: 15_000 })
    await expect(idleButton).toBeEnabled()
    await expect(idleButton).not.toHaveAttribute('title', /release pipeline already running/i)
    await expect(busyButton).not.toBeVisible()
  })
})
