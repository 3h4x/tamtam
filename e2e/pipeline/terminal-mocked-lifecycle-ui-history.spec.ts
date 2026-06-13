import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

import {
  PROJECT,
  RELEASE_JOB_ID,
  finishedReleaseChildJob,
  finishedReleaseJob,
  runningReleaseJob,
  stubProjectShell,
} from './terminal-mocked-lifecycle-ui-fixtures'

test.describe('Mocked terminal lifecycle UI history sync', () => {
  test('history list and terminal landing page stay in sync across a mocked release start and finish', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'done' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'done') {
        return [finishedReleaseJob(0, 'Release output reached both surfaces.\n')]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(0, 'Release output reached both surfaces.\n'),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output reached both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1500,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 8_000 })

    phase = 'done'
    finishStream()

    await expect(page.getByText('Release output reached both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })

  test('history list and terminal landing page stay in sync across a mocked release failure', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'failed' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'failed') {
        const failedChild = finishedReleaseChildJob({
          id: 'mock-release-push-failed',
          kind: 'fix',
          exit_code: 2,
          work_summary: 'Release failed while both surfaces were open.',
        })
        return [
          finishedReleaseJob(
            2,
            'Release output failed on both surfaces.\n',
            'Release failed while both surfaces were open.',
          ),
          failedChild,
        ]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(
                2,
                'Release output failed on both surfaces.\n',
                'Release failed while both surfaces were open.',
              ),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output failed on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: 'Release failed while both surfaces were open.',
            duration: 1500,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    phase = 'failed'
    finishStream()

    await expect(page.getByText('Release output failed on both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Release failed while both surfaces were open.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(releaseRow.getByText('release failed', { exact: true })).toBeVisible({
      timeout: 12_000,
    })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })

  test('history list and terminal landing page stay in sync across a mocked release cancellation', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'cancelled' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'cancelled') {
        const cancelledChild = finishedReleaseChildJob({
          id: 'mock-release-review-cancelled',
          kind: 'fix',
          status: 'aborted',
          exit_code: -3,
          work_summary: 'Release output was cancelled on both surfaces.',
        })
        return [
          finishedReleaseJob(
            -3,
            'Release output was cancelled on both surfaces.\n',
            undefined,
            { status: 'aborted' },
          ),
          cancelledChild,
        ]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(
                -3,
                'Release output was cancelled on both surfaces.\n',
                undefined,
                { status: 'aborted' },
              ),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output was cancelled on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: -3,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    phase = 'cancelled'
    finishStream()

    await expect(page.getByText('Release output was cancelled on both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(releaseRow.getByText('cancelled').first()).toBeVisible({ timeout: 12_000 })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })
})
