import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
} from './helpers'

const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
)

const RUNS_PROJECT = 'external-start-runs'
const TERMINAL_PROJECT = 'external-start-terminal'

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

    await expect(page.getByText(RUNS_PROJECT).first()).toBeVisible({ timeout: 15_000 })
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

  test('fresh terminal landing page auto-attaches to an externally-started release and clears live state on success', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_PROJECT, SUCCESS_SCENARIO.steps)
    resetShimState(TERMINAL_PROJECT)
    await enableProject(request, TERMINAL_PROJECT, { testsDisabled: true })

    await page.goto(`/project/${TERMINAL_PROJECT}/terminal`)
    await expect(page).toHaveURL(new RegExp(`/project/${TERMINAL_PROJECT}/terminal$`))
    await expect(page.getByText('live run')).toHaveCount(0)

    const releaseResponse = await request.post(`/api/projects/by-project/${TERMINAL_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const runningReview = await waitForJobRunning(request, TERMINAL_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await expect(page).toHaveURL(
      new RegExp(`/project/${TERMINAL_PROJECT}/terminal\\?job=`),
      { timeout: 15_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 15_000,
    })

    const result = await waitForPipelineCompletion(request, TERMINAL_PROJECT, 90_000)
    expect(result.status, 'pipeline should complete').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0)

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText(/Verdict: LGTM/).first()).toBeVisible({ timeout: 15_000 })
  })
})
