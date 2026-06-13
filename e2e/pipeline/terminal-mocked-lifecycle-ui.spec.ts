import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

import {
  JOB_ID,
  PROJECT,
  RELEASE_JOB_ID,
  RELEASE_JOB_ID_NEWER,
  RELEASE_JOB_ID_OLDER,
  RUN_JOB_ID,
  RUN_SESSION_ID,
  SESSION_ID,
  finishedJob,
  finishedReleaseJob,
  runningJob,
  runningReleaseJob,
  runningTerminalRunJob,
  now,
  stubProjectShell,
} from './terminal-mocked-lifecycle-ui-fixtures'

test.describe('Mocked terminal lifecycle UI', () => {
  test('terminal job deep link shows live run, then clears after streamed success', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(0, 'Mocked review output reached the terminal.\n'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output reached the terminal.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output reached the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state and shows stream failure details', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(2, 'Mocked review output failed in the terminal.\n', 'Mock provider failed hard'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output failed in the terminal.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed hard',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output failed in the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Mock provider failed hard')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state after streamed cancellation', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(-3, 'Mocked review output stopped before completion.\n'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output stopped before completion.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: -3,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 700,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output stopped before completion.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal landing page auto-attaches when a release starts after the page is already open', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(0, 'Release output reached the terminal after auto-attach.\n'),
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
          'data: Release output reached the terminal after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(
      page.getByText('Release output reached the terminal after auto-attach.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page auto-attaches to a release failure and clears live state', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(2, 'Release output failed after auto-attach.\n', 'Release failed during push after auto-attach'),
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
          'data: Release output failed after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: 'Release failed during push after auto-attach',
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(page.getByText('Release output failed after auto-attach.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Release failed during push after auto-attach')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
  })

  test('terminal landing page auto-attaches to a cancelled release and clears live state', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(-3, 'Release output was cancelled after auto-attach.\n'),
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
          'data: Release output was cancelled after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: -3,
            provider: 'claude',
            duration: 1100,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(page.getByText('Release output was cancelled after auto-attach.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
  })

  test('terminal landing page auto-attaches when an ordinary run starts elsewhere', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Ordinary run output reached the landing page after auto-attach.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: RUN_SESSION_ID,
            provider: 'claude',
            duration: 900,
          })}`,
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
    await expect(page.getByText('Keep the landing page idle.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)

    serveRunningRun = false
    finishStream()

    await expect(
      page.getByText('Ordinary run output reached the landing page after auto-attach.'),
    ).toBeVisible({
      timeout: 8_000,
    })
  })

  test('terminal landing page stays on an attached ordinary run when a release starts later', async ({
    page,
  }) => {
    let phase: 'idle' | 'run-only' | 'run-and-release' = 'idle'
    let runOnlyPolls = 0

    await stubProjectShell(page, () => {
      if (phase === 'run-only') {
        runOnlyPolls += 1
        return [runningTerminalRunJob()]
      }
      if (phase === 'run-and-release') return [runningTerminalRunJob(), runningReleaseJob()]
      return []
    })
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runningReleaseJob(),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    phase = 'run-only'

    await expect.poll(() => runOnlyPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)

    phase = 'run-and-release'

    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)
  })

  test('terminal landing page auto-attaches to the newest running release when multiple releases are live', async ({
    page,
  }) => {
    const olderRelease = runningReleaseJob({
      id: RELEASE_JOB_ID_OLDER,
      release_id: RELEASE_JOB_ID_OLDER,
      started_at: now() - 20,
      work_summary: 'Older release is still running.',
    })
    const newerRelease = runningReleaseJob({
      id: RELEASE_JOB_ID_NEWER,
      release_id: RELEASE_JOB_ID_NEWER,
      started_at: now() - 3,
      work_summary: 'Newest release should win the auto-attach.',
    })

    await stubProjectShell(page, () => [olderRelease, newerRelease])
    await page.route(`**/api/jobs/${RELEASE_JOB_ID_OLDER}`, (route: Route) =>
      route.fulfill({
        json: olderRelease,
      }),
    )
    await page.route(`**/api/jobs/${RELEASE_JOB_ID_NEWER}`, (route: Route) =>
      route.fulfill({
        json: newerRelease,
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID_NEWER}`, (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID_NEWER)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace').first()).toBeVisible({
      timeout: 8_000,
    })
  })
})
