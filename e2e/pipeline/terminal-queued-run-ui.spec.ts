import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'
import {
  PROJECT,
  stubProjectShell,
} from './terminal-mocked-lifecycle-ui-fixtures'

// When a terminal run POST returns 202 { status: 'queued' } because a release
// or other blocking job is running, the terminal must:
//   1. Show a muted "⏳ Queued (#N) — will run after <kind> finishes" line.
//   2. Poll the queued-run status endpoint until it starts.
//   3. Auto-attach the live stream once the queued run transitions to 'started'.
//
// This is distinct from the 409 error path (now eliminated) and from a normal
// 200 immediate-start path. No real run is spawned; all HTTP is mocked.

test.describe('Queued terminal run UI', () => {
  test('terminal shows queued notice when run POST returns 202 with blocking kind', async ({
    page,
  }) => {
    // No active jobs — landing page is idle.
    await stubProjectShell(page, () => [])
    // Prevent SSE connections from hanging.
    await page.route('**/api/streaming/**', (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )
    // Run POST returns 202 queued because a release is running.
    await page.route(
      `**/api/projects/by-project/${PROJECT}/run`,
      (route: Route) => {
        if (route.request().method() !== 'POST') { route.fallback(); return }
        route.fulfill({
          status: 202,
          json: {
            status: 'queued',
            queueId: 'q-blocked-release-1',
            position: 1,
            blockingKind: 'release',
          },
        })
      },
    )
    // queued-runs status endpoint: stays pending indefinitely for this test.
    await page.route(
      `**/api/projects/by-project/${PROJECT}/queued-runs/q-blocked-release-1`,
      (route: Route) =>
        route.fulfill({ json: { status: 'pending', jobId: null } }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    // Wait for the idle landing page to settle (no active job).
    const input = page.getByPlaceholder('type a message...')
    await expect(input).toBeVisible({ timeout: 8_000 })

    await input.fill('Refactor the auth middleware')
    await input.press('Enter')

    // The queued notice must appear immediately, not an error banner.
    await expect(
      page.getByText('⏳ Queued (#1) — will run after release finishes', { exact: true }),
    ).toBeVisible({ timeout: 8_000 })

    // No error entry must appear in the terminal history — the 202 is not a
    // failure. An error entry would show the "✗ error" label (from TerminalMessages).
    await expect(page.getByText('✗ error', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Failed to start', { exact: false })).toHaveCount(0)
  })

  test('terminal auto-attaches live stream when queued run transitions to started', async ({
    page,
  }) => {
    const QUEUE_ID = 'q-auto-attach-1'
    const JOB_ID = 'job-queued-started-1'
    let queueStatus: 'pending' | 'started' = 'pending'

    await stubProjectShell(page, () => [])
    // Keep all streaming requests in limbo — we only care that startStream is
    // called, not that the SSE delivers content. Streaming mode appearance
    // (the live-run spinner) proves the auto-attach fired.
    await page.route('**/api/streaming/**', (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )
    await page.route(
      `**/api/projects/by-project/${PROJECT}/run`,
      (route: Route) => {
        if (route.request().method() !== 'POST') { route.fallback(); return }
        route.fulfill({
          status: 202,
          json: { status: 'queued', queueId: QUEUE_ID, position: 1, blockingKind: 'fix' },
        })
      },
    )
    // queued-runs status starts pending, then transitions to started.
    await page.route(
      `**/api/projects/by-project/${PROJECT}/queued-runs/${QUEUE_ID}`,
      (route: Route) =>
        route.fulfill({
          json:
            queueStatus === 'started'
              ? { status: 'started', jobId: JOB_ID }
              : { status: 'pending', jobId: null },
        }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    const input = page.getByPlaceholder('type a message...')
    await expect(input).toBeVisible({ timeout: 8_000 })

    await input.fill('Refactor the session manager')
    await input.press('Enter')

    // Queued notice appears — run was deferred, not rejected.
    await expect(
      page.getByText('⏳ Queued (#1) — will run after fix finishes', { exact: true }),
    ).toBeVisible({ timeout: 8_000 })

    // While pending, the terminal stays idle (not streaming).
    await expect(page.getByLabel('live run spinner')).toHaveCount(0)

    // Transition queued run to started — TerminalTab poll will pick this up
    // within one poll cycle (≤ 2s) and call startStream.
    queueStatus = 'started'

    // Once the poll returns 'started', startStream fires and the terminal
    // enters streaming mode. The live-run spinner proves auto-attach happened.
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 })
    // The input placeholder switches to "queue a message..." when streaming.
    await expect(page.getByPlaceholder('queue a message... (Esc cancels)')).toBeVisible({
      timeout: 8_000,
    })
  })

  test('terminal shows queued notice at position 2 when two runs are queued', async ({
    page,
  }) => {
    await stubProjectShell(page, () => [])
    await page.route('**/api/streaming/**', (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )
    let callCount = 0
    await page.route(
      `**/api/projects/by-project/${PROJECT}/run`,
      (route: Route) => {
        if (route.request().method() !== 'POST') { route.fallback(); return }
        callCount++
        route.fulfill({
          status: 202,
          json: {
            status: 'queued',
            queueId: `q-position-${callCount}`,
            position: callCount,
            blockingKind: 'release',
          },
        })
      },
    )
    await page.route(
      (url) =>
        url.pathname.startsWith(
          `/api/projects/by-project/${PROJECT}/queued-runs/`,
        ),
      (route: Route) => route.fulfill({ json: { status: 'pending', jobId: null } }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    const input = page.getByPlaceholder('type a message...')
    await expect(input).toBeVisible({ timeout: 8_000 })

    await input.fill('First queued message')
    await input.press('Enter')
    await expect(
      page.getByText('⏳ Queued (#1) — will run after release finishes', { exact: true }),
    ).toBeVisible({ timeout: 8_000 })

    // Second queued run while the terminal is still in "queued" state.
    await input.fill('Second queued message')
    await input.press('Enter')
    await expect(
      page.getByText('⏳ Queued (#2) — will run after release finishes', { exact: true }),
    ).toBeVisible({ timeout: 8_000 })

    // Neither queued submission should show an error entry.
    await expect(page.getByText('✗ error', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Failed to start', { exact: false })).toHaveCount(0)
  })
})
