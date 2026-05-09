/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { GlobalRecommendationsPage } from '@/components/GlobalRecommendationsPage'
import type { Recommendation } from '@/lib/client-api'

const { fetchAllOpenRecommendationsMock, updateRecommendationMock, applyRecommendationMock } = vi.hoisted(() => ({
  fetchAllOpenRecommendationsMock: vi.fn(),
  updateRecommendationMock: vi.fn(),
  applyRecommendationMock: vi.fn(),
}))

vi.mock('@/lib/client-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-api')>('@/lib/client-api')
  return {
    ...actual,
    fetchAllOpenRecommendations: fetchAllOpenRecommendationsMock,
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

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(GlobalRecommendationsPage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('GlobalRecommendationsPage', () => {
  beforeEach(() => {
    fetchAllOpenRecommendationsMock.mockReset()
    updateRecommendationMock.mockReset()
    applyRecommendationMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('groups open recommendations by project and orders the busiest project first', async () => {
    fetchAllOpenRecommendationsMock.mockResolvedValue({
      recommendations: [
        makeRecommendation({ id: 'beta-1', project: 'beta', title: 'Beta 1' }),
        makeRecommendation({ id: 'alpha-1', project: 'alpha', title: 'Alpha 1' }),
        makeRecommendation({ id: 'beta-2', project: 'beta', title: 'Beta 2' }),
      ],
    })

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(fetchAllOpenRecommendationsMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('3 open')
      expect(container.textContent).toContain('Beta 1')
      expect(container.textContent).toContain('Alpha 1')
    })

    const headings = Array.from(container.querySelectorAll('h2')).map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    expect(headings).toEqual(['beta2', 'alpha1'])

    const links = Array.from(container.querySelectorAll('a')).map((node) => node.getAttribute('href'))
    expect(links).toContain('/project/beta/recommendations')
    expect(links).toContain('/project/alpha/recommendations')

    unmount()
  })

  it('applies a recommendation, reloads, and leaves dismiss errors inline to the item', async () => {
    const alpha = makeRecommendation({ id: 'alpha-1', project: 'alpha', title: 'Alpha' })
    const beta = makeRecommendation({ id: 'beta-1', project: 'beta', title: 'Beta' })

    fetchAllOpenRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [alpha, beta] })
      .mockResolvedValueOnce({ recommendations: [beta] })
      .mockResolvedValueOnce({ recommendations: [beta] })
    applyRecommendationMock.mockResolvedValue({ recommendation: { ...alpha, status: 'applied' } })
    updateRecommendationMock.mockRejectedValue(new Error('cannot dismiss beta'))

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Alpha')
      expect(container.textContent).toContain('Beta')
    })

    const acceptButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Accept')
    acceptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(applyRecommendationMock).toHaveBeenCalledWith('alpha', expect.objectContaining({ id: 'alpha-1' }))
      expect(fetchAllOpenRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('Alpha')
    })

    const dismissButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'dismiss')
    dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(updateRecommendationMock).toHaveBeenCalledWith('beta', 'beta-1', 'dismissed')
      expect(fetchAllOpenRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('cannot dismiss beta')
      expect(container.textContent).toContain('Beta')
    })

    unmount()
  })

  it('shows a load error instead of the empty state when the initial fetch fails', async () => {
    fetchAllOpenRecommendationsMock.mockRejectedValue(new Error('summary endpoint down'))

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to load recommendations.')
      expect(container.textContent).toContain('summary endpoint down')
    })

    expect(container.textContent).not.toContain('No open recommendations across any project.')

    unmount()
  })

  it('treats an apply reload failure as a page refresh error, not an item action failure', async () => {
    const alpha = makeRecommendation({ id: 'alpha-1', project: 'alpha', title: 'Alpha' })

    fetchAllOpenRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [alpha] })
      .mockRejectedValueOnce(new Error('refresh failed after apply'))
    applyRecommendationMock.mockResolvedValue({ recommendation: { ...alpha, status: 'applied' } })

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Alpha')
    })

    const acceptButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Accept')
    acceptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(applyRecommendationMock).toHaveBeenCalledWith('alpha', expect.objectContaining({ id: 'alpha-1' }))
      expect(fetchAllOpenRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Failed to load recommendations.')
      expect(container.textContent).toContain('refresh failed after apply')
    })

    expect(container.textContent).not.toContain('Failed to apply recommendation')
    expect(container.textContent).not.toContain('Alpha')

    unmount()
  })

  it('treats a dismiss reload failure as a page refresh error, not an item action failure', async () => {
    const beta = makeRecommendation({ id: 'beta-1', project: 'beta', title: 'Beta' })

    fetchAllOpenRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [beta] })
      .mockRejectedValueOnce(new Error('refresh failed after dismiss'))
    updateRecommendationMock.mockResolvedValue({ recommendation: { ...beta, status: 'dismissed' } })

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Beta')
    })

    const dismissButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'dismiss')
    dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(updateRecommendationMock).toHaveBeenCalledWith('beta', 'beta-1', 'dismissed')
      expect(fetchAllOpenRecommendationsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('refresh failed after dismiss')
    })

    expect(container.textContent).not.toContain('Failed to dismiss')
    expect(container.textContent).not.toContain('Beta')

    unmount()
  })
})
