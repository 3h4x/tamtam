import { test, expect } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  acquirePipelineSharedStateLock,
  type PipelineSharedStateLock,
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
const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
)
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
)

const RUNS_PROJECT = 'external-start-runs'
const TERMINAL_FAILURE_PROJECT = 'external-start-failure'
const TERMINAL_ABORT_PROJECT = 'abort'
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix'
const LONG_FAILURE_STEPS = FAILURE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 20_000 } : step,
)
let sharedStateLock: PipelineSharedStateLock | null = null

function workflowRunLink(panel: Locator, project: string): Locator {
  return panel.getByRole('link').filter({ hasText: project }).first()
}

test.describe('External-start lifecycle surfaces', () => {
  test.beforeEach(async () => {
    sharedStateLock = await acquirePipelineSharedStateLock('external-start-lifecycle-real')
  })

  test.afterEach(async ({ request }) => {
    try {
      const patch = await request.patch('/api/settings', {
        data: { review_do_not_ship_action: DEFAULT_DO_NOT_SHIP_ACTION },
      })
      expect(
        patch.ok(),
        `failed to restore review_do_not_ship_action: ${patch.status()}`,
      ).toBe(true)
    } finally {
      sharedStateLock?.release()
      sharedStateLock = null
    }
  })

  test('workflow runs page picks up an externally-started release from idle state and clears active state after completion', async ({
    page,
    request,
  }) => {
    writeScenario(RUNS_PROJECT, SUCCESS_SCENARIO.steps)
    resetShimState(RUNS_PROJECT)
    writeGitTiming(RUNS_PROJECT, { push: 6500 })
    await enableProject(request, RUNS_PROJECT, { testsDisabled: true })

    await page.goto('/workflow-runs')
    const activePanel = page.getByLabel('Active workflow runs')
    const activeRunCard = workflowRunLink(activePanel, RUNS_PROJECT)
    await expect(activeRunCard).toHaveCount(0)

    const releaseResponse = await request.post(`/api/projects/by-project/${RUNS_PROJECT}/release`)
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const runningReview = await waitForJobRunning(request, RUNS_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await expect(activePanel).toBeVisible({ timeout: 20_000 })
    await expect(activeRunCard).toBeVisible({ timeout: 20_000 })
    await expect(activeRunCard.getByLabel('status running')).toBeVisible({ timeout: 20_000 })

    const result = await waitForPipelineCompletion(request, RUNS_PROJECT, 90_000)
    expect(result.status, 'pipeline should complete').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0)

    const completedRow = page.getByRole('row').filter({ hasText: RUNS_PROJECT }).first()
    await expect(activeRunCard).toHaveCount(0, { timeout: 15_000 })
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 })
  })

  test('fresh terminal landing page auto-attaches to an externally-started release failure and clears live state in place', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_FAILURE_PROJECT, LONG_FAILURE_STEPS)
    resetShimState(TERMINAL_FAILURE_PROJECT)
    await enableProject(request, TERMINAL_FAILURE_PROJECT, { testsDisabled: true })
    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    })
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true)

    await page.goto(`/project/${TERMINAL_FAILURE_PROJECT}/terminal`)
    await expect(page).toHaveURL(new RegExp(`/project/${TERMINAL_FAILURE_PROJECT}/terminal$`))
    await expect(page.getByText('live run')).toHaveCount(0)

    const releaseResponse = await request.post(
      `/api/projects/by-project/${TERMINAL_FAILURE_PROJECT}/release`,
    )
    expect(
      releaseResponse.status(),
      `release POST failed: ${await releaseResponse.text()}`,
    ).toBe(200)

    const releaseBody = await releaseResponse.json() as { release_job_id: string }
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy()

    const runningReview = await waitForJobRunning(request, TERMINAL_FAILURE_PROJECT, 'review', 20_000)
    expect(runningReview, 'review job should be running').not.toBeNull()

    await expect(page).toHaveURL(
      new RegExp(`/project/${TERMINAL_FAILURE_PROJECT}/terminal\\?job=`),
      { timeout: 15_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTitle('review in progress — click to open terminal').first()).toBeVisible({
      timeout: 15_000,
    })

    const result = await waitForPipelineCompletion(
      request,
      TERMINAL_FAILURE_PROJECT,
      90_000,
      releaseBody.release_job_id,
    )
    expect(result.status, 'pipeline should finish').toBe('done')
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0)

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/release blocked/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/critical security vulnerabilities/i).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/DO NOT SHIP/i).first()).toBeVisible({ timeout: 15_000 })
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
