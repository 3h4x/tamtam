import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  writeScenario,
  resetShimState,
  enableProject,
  writeGitTiming,
  waitForJobRunning,
  waitForJobCompletion,
  waitForPipelineCompletion,
} from './helpers'

const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
)
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
)

const PAUSED_PROJECT = 'release-controls-paused'
const SUCCESS_PROJECT = 'release-controls-happy-path'
const BUSY_PROJECT = 'release-controls-abort'
const EXTERNAL_START_PROJECT = 'release-controls-external-start'

test.describe('Real release controls lifecycle', () => {
  test.afterEach(async ({ request }) => {
    await request.patch('/api/settings', { data: { jobs_paused: false } })
  })

  test('release button picks up external jobs_paused changes while the page stays open', async ({
    page,
    request,
  }) => {
    await enableProject(request, PAUSED_PROJECT, { testsDisabled: true })
    await request.patch('/api/settings', { data: { jobs_paused: false } })

    await page.goto(`/project/${PAUSED_PROJECT}`)

    const releaseButton = page.getByRole('button', { name: /release/i }).first()

    await expect(releaseButton).toBeVisible({ timeout: 8_000 })
    await expect(releaseButton).toBeEnabled()

    await request.patch('/api/settings', { data: { jobs_paused: true } })

    await expect(releaseButton).toBeDisabled({ timeout: 15_000 })
    await expect(releaseButton).toHaveAttribute('title', /jobs are paused globally/i)

    await request.patch('/api/settings', { data: { jobs_paused: false } })

    await expect(releaseButton).toBeEnabled({ timeout: 15_000 })
    await expect(releaseButton).not.toHaveAttribute('title', /jobs are paused globally/i)
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

  test('release button detects an externally-started live release and resets after completion without reload', async ({
    page,
    request,
  }) => {
    writeScenario(EXTERNAL_START_PROJECT, SUCCESS_SCENARIO.steps)
    resetShimState(EXTERNAL_START_PROJECT)
    writeGitTiming(EXTERNAL_START_PROJECT, { push: 6500 })
    await enableProject(request, EXTERNAL_START_PROJECT, { testsDisabled: true })

    await page.goto(`/project/${EXTERNAL_START_PROJECT}`)

    const idleButton = page.getByRole('button', { name: '🚀 Release' })
    await expect(idleButton).toBeVisible({ timeout: 8_000 })
    await expect(idleButton).toBeEnabled()

    const releaseResponse = await request.post(`/api/projects/by-project/${EXTERNAL_START_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const runningReview = await waitForJobRunning(request, EXTERNAL_START_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    const busyButton = page.getByRole('button', { name: /releasing/i })
    await expect(busyButton).toBeVisible({ timeout: 15_000 })
    await expect(busyButton).toBeDisabled()
    await expect(busyButton).toHaveAttribute('title', /release pipeline already running/i)

    const result = await waitForPipelineCompletion(request, EXTERNAL_START_PROJECT, 90_000)
    expect(result.status, 'pipeline should complete').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0)

    await expect(busyButton).not.toBeVisible()
    await expect(page.getByRole('button', { name: /🚀 Release|🚢 Ship \(LGTM\)/ }).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('button', { name: /🚀 Release|🚢 Ship \(LGTM\)/ }).first()).toBeEnabled()
  })

  test('release button resets to the Ship state after a successful live release without reload', async ({
    page,
    request,
  }) => {
    writeScenario(SUCCESS_PROJECT, SUCCESS_SCENARIO.steps)
    resetShimState(SUCCESS_PROJECT)
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true })

    const releaseResponse = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const runningReview = await waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await page.goto(`/project/${SUCCESS_PROJECT}`)

    const busyButton = page.getByRole('button', { name: /releasing/i })
    await expect(busyButton).toBeVisible({ timeout: 8_000 })
    await expect(busyButton).toBeDisabled()
    await expect(busyButton).toHaveAttribute('title', /release pipeline already running/i)

    const result = await waitForPipelineCompletion(request, SUCCESS_PROJECT, 90_000)
    expect(result.status, 'pipeline should complete').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0)

    const idleButton = page.getByRole('button', { name: '🚢 Ship (LGTM)' })
    await expect(idleButton).toBeVisible({ timeout: 15_000 })
    await expect(idleButton).toBeEnabled()
    await expect(idleButton).toHaveAttribute('title', /ship it/i)
    await expect(page.getByRole('button', { name: /Review LGTM just now .* awaiting push/i })).toBeVisible({
      timeout: 15_000,
    })
    await expect(busyButton).not.toBeVisible()
  })
})
