import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  writeScenario,
  resetShimState,
  enableProject,
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

const RUNS_PROJECT = 'start-detect-runs'
const TERMINAL_ABORT_PROJECT = 'abort'

test.describe('External-start lifecycle surfaces', () => {
  test('global runs list picks up an externally-started release and shows the running spinner before completion', async ({
    page,
    request,
  }) => {
    writeScenario(RUNS_PROJECT, SUCCESS_SCENARIO.steps)
    resetShimState(RUNS_PROJECT)
    await enableProject(request, RUNS_PROJECT, { testsDisabled: true })

    await page.goto(`/runs?project=${encodeURIComponent(RUNS_PROJECT)}`)
    await expect(page.getByText(RUNS_PROJECT)).toHaveCount(0)

    const releaseResponse = await request.post(`/api/projects/by-project/${RUNS_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const runningReview = await waitForJobRunning(request, RUNS_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await expect(page.getByRole('button', { name: /running [1-9]/i })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span.animate-pulse').first()).toBeVisible({ timeout: 15_000 })

    const result = await waitForPipelineCompletion(request, RUNS_PROJECT, 90_000)
    expect(result.status, 'pipeline should complete').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0)

    await expect(page.getByText('done').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 })
  })

  test('fresh terminal landing page auto-attaches to an externally-started release and clears live state after abort', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_ABORT_PROJECT, ABORT_SCENARIO.steps)
    resetShimState(TERMINAL_ABORT_PROJECT)
    await enableProject(request, TERMINAL_ABORT_PROJECT, { testsDisabled: true })

    await page.goto(`/project/${TERMINAL_ABORT_PROJECT}/terminal`)
    await expect(page).toHaveURL(new RegExp(`/project/${TERMINAL_ABORT_PROJECT}/terminal$`))
    await expect(page.getByText('live run')).toHaveCount(0)

    const releaseResponse = await request.post(
      `/api/projects/by-project/${TERMINAL_ABORT_PROJECT}/release`,
    )
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const releaseBody = await releaseResponse.json() as { release_job_id: string }
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy()

    const runningReview = await waitForJobRunning(request, TERMINAL_ABORT_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await expect(page).toHaveURL(
      new RegExp(`/project/${TERMINAL_ABORT_PROJECT}/terminal\\?job=`),
      { timeout: 15_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTitle('review in progress — click to open terminal').first()).toBeVisible({
      timeout: 15_000,
    })

    const abortResponse = await request.post(
      `/api/projects/by-project/${TERMINAL_ABORT_PROJECT}/release/abort`,
    )
    expect(abortResponse.status()).toBe(200)

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000)
    expect(releaseJob, 'release job should finish after abort').not.toBeNull()
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3)

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 })
  })
})
