/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { NotificationsTab, type NotificationsSettings } from '@/components/settings/NotificationsTab'

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  }
}

function baseSettings(): NotificationsSettings {
  return {
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: 'true',
    notification_on_release_fail: 'false',
    notification_on_release_aborted: 'false',
    notification_on_fix_loop_exhausted: 'false',
    notification_on_review_do_not_ship: 'false',
    notification_on_agent_run_fail: 'false',
    notification_on_budget_blocked: 'false',
  }
}

function renderNotificationsTab(
  settings: NotificationsSettings = baseSettings(),
  onChange = vi.fn(),
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(NotificationsTab, { settings, onChange }))
  })

  return {
    container,
    onChange,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === label,
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`)
  return button
}

describe('NotificationsTab', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('sends a test notification and resets the success state after the timeout', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = baseSettings()
    settings.notification_webhook_url = 'https://hooks.example.test/abc'
    settings.notification_webhook_secret = 'secret'

    const { container, unmount } = renderNotificationsTab(settings)

    findButton(container, 'Send Test').click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/settings/test-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_url: 'https://hooks.example.test/abc',
          webhook_secret: 'secret',
        }),
      })
      expect(findButton(container, 'Sent!')).toBeTruthy()
    })

    vi.advanceTimersByTime(3000)

    await vi.waitFor(() => {
      expect(findButton(container, 'Send Test')).toBeTruthy()
    })

    unmount()
  })

  it('shows the request error and clears it after the retry timeout', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ ok: false, error: 'webhook refused' }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = baseSettings()
    settings.notification_webhook_url = 'https://hooks.example.test/abc'

    const { container, unmount } = renderNotificationsTab(settings)

    findButton(container, 'Send Test').click()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('webhook refused')
    })

    vi.advanceTimersByTime(5000)

    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('webhook refused')
      expect(findButton(container, 'Send Test')).toBeTruthy()
    })

    unmount()
  })
})
