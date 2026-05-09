/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RecommendationsTab } from '@/components/project-detail/RecommendationsTab'
import type { Recommendation } from '@/lib/client-api'

const {
  fetchRecommendationsMock,
  updateRecommendationMock,
  applyRecommendationMock,
} = vi.hoisted(() => ({
  fetchRecommendationsMock: vi.fn(),
  updateRecommendationMock: vi.fn(),
  applyRecommendationMock: vi.fn(),
}))

vi.mock('@/lib/client-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-api')>('@/lib/client-api')
  return {
    ...actual,
    fetchRecommendations: fetchRecommendationsMock,
    updateRecommendation: updateRecommendationMock,
    applyRecommendation: applyRecommendationMock,
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, className }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}))

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    project: 'alpha',
    source_kind: 'agent:tests',
    source_id: 'job-1',
    agent_id: 'agent-1',
    agent_name: 'tests',
    type: 'agent_schedule_backoff',
    title: 'Back off tests',
    detail: 'No actionable work.',
    status: 'open',
    payload: { currentSchedule: '1h', recommendedSchedule: '4h' },
    created_at: 100,
    updated_at: 200,
    ...overrides,
  }
}

function renderTab() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(RecommendationsTab, { projectName: 'alpha' }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('RecommendationsTab', () => {
  beforeEach(() => {
    fetchRecommendationsMock.mockReset()
    updateRecommendationMock.mockReset()
    applyRecommendationMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a load error instead of the empty state when the initial fetch fails', async () => {
    fetchRecommendationsMock.mockRejectedValue(new Error('project recommendations unavailable'))

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to load recommendations.')
      expect(container.textContent).toContain('project recommendations unavailable')
    })

    expect(container.textContent).not.toContain('No open recommendations for this project.')

    unmount()
  })

  it('keeps a successful accept from being reported as an inline failure when the reload fails', async () => {
    const recommendation = makeRecommendation()

    fetchRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [recommendation] })
      .mockRejectedValueOnce(new Error('refresh failed after apply'))
    applyRecommendationMock.mockResolvedValue({ recommendation: { ...recommendation, status: 'applied' } })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Back off tests')
    })

    const acceptButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Accept')
    acceptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(applyRecommendationMock).toHaveBeenCalledWith('alpha', expect.objectContaining({ id: 'rec-1' }))
      expect(fetchRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Failed to load recommendations.')
      expect(container.textContent).toContain('refresh failed after apply')
    })

    expect(container.textContent).not.toContain('Failed to apply recommendation')
    expect(container.textContent).not.toContain('Back off tests')

    unmount()
  })

  it('keeps a successful dismiss from being reported as an inline failure when the reload fails', async () => {
    const recommendation = makeRecommendation()

    fetchRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [recommendation] })
      .mockRejectedValueOnce(new Error('refresh failed after dismiss'))
    updateRecommendationMock.mockResolvedValue({ recommendation: { ...recommendation, status: 'dismissed' } })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Back off tests')
    })

    const dismissButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'dismiss')
    dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(updateRecommendationMock).toHaveBeenCalledWith('alpha', 'rec-1', 'dismissed')
      expect(fetchRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Failed to load recommendations.')
      expect(container.textContent).toContain('refresh failed after dismiss')
    })

    expect(container.textContent).not.toContain('Failed to dismiss')
    expect(container.textContent).not.toContain('Back off tests')

    unmount()
  })
})
