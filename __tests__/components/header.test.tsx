/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Header } from '@/components/Header'

const { fetchRecommendationsSummaryMock, fetchInboxMock, usePathnameMock, useRouterMock } = vi.hoisted(() => ({
  fetchRecommendationsSummaryMock: vi.fn(),
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
  fetchRecommendationsSummary: fetchRecommendationsSummaryMock,
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
    fetchRecommendationsSummaryMock.mockReset()
    fetchInboxMock.mockReset()
    fetchInboxMock.mockResolvedValue({ signals: [], counts: { red: 0, yellow: 0, green: 0, total: 0 } })
    usePathnameMock.mockReset()
    useRouterMock.mockReset()
    usePathnameMock.mockReturnValue('/recommendations')
    useRouterMock.mockReturnValue({ replace: vi.fn(), refresh: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the open recommendations chip and polls every 60 seconds', async () => {
    fetchRecommendationsSummaryMock
      .mockResolvedValueOnce({ openCount: 3, byProject: { alpha: 2, beta: 1 } })
      .mockResolvedValueOnce({ openCount: 1, byProject: { beta: 1 } })

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchRecommendationsSummaryMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('Recommendations')
      expect(container.querySelector('[aria-label="3 open recommendations"]')).not.toBeNull()
    })

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(fetchRecommendationsSummaryMock).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[aria-label="1 open recommendation"]')).not.toBeNull()
    })

    unmount()
  })

  it('hides a previously shown chip when a later poll fails', async () => {
    fetchRecommendationsSummaryMock
      .mockResolvedValueOnce({ openCount: 3, byProject: { alpha: 2, beta: 1 } })
      .mockRejectedValueOnce(new Error('boom'))

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchRecommendationsSummaryMock).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[aria-label="3 open recommendations"]')).not.toBeNull()
    })

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(fetchRecommendationsSummaryMock).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[aria-label*="open recommendation"]')).toBeNull()
    })

    unmount()
  })

  it('fails open when the summary request errors', async () => {
    fetchRecommendationsSummaryMock.mockRejectedValue(new Error('boom'))

    const { container, unmount } = renderHeader()

    await vi.waitFor(() => {
      expect(fetchRecommendationsSummaryMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('Recommendations')
    })

    expect(container.querySelector('[aria-label*="open recommendation"]')).toBeNull()

    unmount()
  })
})
