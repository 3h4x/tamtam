/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RecommendationsTab } from '@/components/RecommendationsTab'
import type { Recommendation } from '@/lib/client-api'

const { fetchRecommendations, updateRecommendation, applyRecommendation } = vi.hoisted(() => ({
  fetchRecommendations: vi.fn(),
  updateRecommendation: vi.fn(),
  applyRecommendation: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchRecommendations,
  updateRecommendation,
  applyRecommendation,
  AUTO_APPLICABLE_RECOMMENDATION_TYPES: new Set(['agent_schedule_backoff']),
}))

function buildRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    project: 'acme/widgets',
    source_kind: 'agent:tests',
    source_id: null,
    agent_id: null,
    type: 'agent_schedule_backoff',
    status: 'open',
    title: 'Back off agent schedule',
    detail: 'The nightly tests agent keeps finding no changes.',
    agent_name: 'tests',
    payload: { currentSchedule: '1h', recommendedSchedule: '4h' },
    created_at: Math.floor(Date.now() / 1000) - 120,
    updated_at: Math.floor(Date.now() / 1000) - 120,
    ...overrides,
  }
}

function renderRecommendationsTab(projectName = 'acme/widgets') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(RecommendationsTab, { projectName }))
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
    fetchRecommendations.mockReset()
    updateRecommendation.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads open recommendations and shows closed-count metadata', async () => {
    fetchRecommendations.mockResolvedValue({
      recommendations: [
        buildRecommendation(),
        buildRecommendation({
          id: 'rec-2',
          status: 'applied',
          title: 'Already handled',
          payload: {},
        }),
      ],
    })

    const { container, unmount } = renderRecommendationsTab()

    await vi.waitFor(() => {
      expect(fetchRecommendations).toHaveBeenCalledWith('acme/widgets')
      expect(container.textContent).toContain('Recommendations')
      expect(container.textContent).toContain('1 open')
      expect(container.textContent).toContain('schedule')
      expect(container.textContent).toContain('agent:tests')
      expect(container.textContent).toContain('Back off agent schedule')
      expect(container.textContent).toContain('current 1h / suggested 4h')
      expect(container.textContent).toContain('1 dismissed recommendation')
    })

    unmount()
  })

  it('dismisses an open recommendation and reloads the list', async () => {
    fetchRecommendations
      .mockResolvedValueOnce({
        recommendations: [buildRecommendation()],
      })
      .mockResolvedValueOnce({
        recommendations: [
          buildRecommendation({
            status: 'dismissed',
            payload: {},
          }),
        ],
      })
    updateRecommendation.mockResolvedValue(undefined)

    const { container, unmount } = renderRecommendationsTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Back off agent schedule')
    })

    const dismissButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'dismiss')
    dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(updateRecommendation).toHaveBeenCalledWith('acme/widgets', 'rec-1', 'dismissed')
      expect(fetchRecommendations).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('No open recommendations')
      expect(container.textContent).toContain('1 dismissed recommendation')
    })

    unmount()
  })

  it('shows the empty state when there are no open recommendations', async () => {
    fetchRecommendations.mockResolvedValue({
      recommendations: [
        buildRecommendation({
          id: 'rec-3',
          status: 'dismissed',
          payload: {},
        }),
      ],
    })

    const { container, unmount } = renderRecommendationsTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('0 open')
      expect(container.textContent).toContain('No open recommendations')
      expect(container.textContent).toContain('1 dismissed recommendation')
    })

    unmount()
  })
})
