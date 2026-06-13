import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

import {
  PROJECT,
  RUN_JOB_ID,
  RUN_SESSION_ID,
  finishedTerminalRunJob,
  runningTerminalRunJob,
  stubProjectShell,
} from './terminal-mocked-lifecycle-ui-fixtures'

test.describe('Mocked terminal lifecycle UI ordinary run end-states', () => {
  // -------------------------------------------------------------------------
  // Ordinary-run auto-attach end-states — spinner clears on all outcomes
  //
  // The existing auto-attach test proves the landing page routes to the session
  // and the spinner appears, but stops before verifying the spinner clears when
  // the stream closes. These three tests pin the end-state for each outcome so
  // an orphaned spinner cannot regress undetected.
  // -------------------------------------------------------------------------
  test('terminal landing page clears spinner and shows exit 0 after an ordinary run completes via stream', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(0, 'Ordinary run success output.')]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(0, 'Ordinary run success output.')
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run success output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 0, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 900 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run success output.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page clears spinner and shows failure detail after an ordinary run fails via stream', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const failureDetail = 'Provider connection reset after retry budget exhausted.'

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(2, 'Ordinary run failure output.', failureDetail)]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(2, 'Ordinary run failure output.', failureDetail)
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run failure output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 2, sessionId: RUN_SESSION_ID, provider: 'claude', detail: failureDetail, duration: 600 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run failure output.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(failureDetail)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page clears spinner and shows cancelled state after an ordinary run is cancelled via stream', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(-3, 'Ordinary run was cancelled.')]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(-3, 'Ordinary run was cancelled.')
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run was cancelled.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: -3, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 400 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run was cancelled.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })
})
