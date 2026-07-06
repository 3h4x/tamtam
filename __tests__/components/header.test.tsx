/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Header } from '@/components/Header'

const { fetchInboxMock, usePathnameMock, useRouterMock } = vi.hoisted(() => ({
  fetchInboxMock: vi.fn(),
  usePathnameMock: vi.fn(),
  useRouterMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: useRouterMock,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}))

vi.mock('@/lib/client-api', () => ({
  fetchInbox: fetchInboxMock,
}))

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <div>theme</div>,
}))

vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => <div>bell</div>,
}))

vi.mock('@/components/PrivacyToggle', () => ({
  PrivacyToggle: () => <div>privacy</div>,
}))

vi.mock('@/components/JobsPauseToggle', () => ({
  JobsPauseToggle: () => <div>pause</div>,
}))

function renderHeader() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(Header, { loading: false, lastRefresh: Date.now() }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('Header', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchInboxMock.mockReset()
    fetchInboxMock.mockResolvedValue({ signals: [], counts: { red: 0, yellow: 0, green: 0, total: 0 } })
    usePathnameMock.mockReset()
    useRouterMock.mockReset()
    usePathnameMock.mockReturnValue('/inbox')
    useRouterMock.mockReturnValue({ replace: vi.fn(), refresh: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the urgent inbox chip and polls every 60 seconds', async () => {
    fetchInboxMock
      .mockResolvedValueOnce({ signals: [], counts: { red: 3, yellow: 0, green: 0, total: 3 } })
      .mockResolvedValueOnce({ signals: [], counts: { red: 1, yellow: 0, green: 0, total: 1 } })

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchInboxMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('Inbox')
      expect(container.querySelector('[aria-label="3 urgent inbox signals"]')).not.toBeNull()
    })

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(fetchInboxMock).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[aria-label="1 urgent inbox signal"]')).not.toBeNull()
    })

    unmount()
  })

  it('hides a previously shown chip when a later poll fails', async () => {
    fetchInboxMock
      .mockResolvedValueOnce({ signals: [], counts: { red: 3, yellow: 0, green: 0, total: 3 } })
      .mockRejectedValueOnce(new Error('boom'))

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchInboxMock).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[aria-label="3 urgent inbox signals"]')).not.toBeNull()
    })

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(fetchInboxMock).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[aria-label*="urgent inbox signal"]')).toBeNull()
    })

    unmount()
  })

  it('fails open when the inbox request errors', async () => {
    fetchInboxMock.mockRejectedValue(new Error('boom'))

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchInboxMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('Inbox')
    })

    expect(container.querySelector('[aria-label*="urgent inbox signal"]')).toBeNull()

    unmount()
  })
})
