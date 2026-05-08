/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RecommendationsTab } from '@/components/RecommendationsTab'
import type { Recommendation } from '@/lib/client-api'

const { fetchRecommendationsMock, updateRecommendationMock, applyRecommendationMock } = vi.hoisted(() => ({
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

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    project: 'portal',
    source_kind: 'agent:tests',
    source_id: 'job-1',
    agent_id: 'agent-1',
    agent_name: 'tests',
    type: 'agent_schedule_backoff',
    title: 'Run tests less often',
    detail: 'No actionable work.',
    status: 'open',
    payload: { currentSchedule: '4h', recommendedSchedule: '8h' },
    created_at: 100,
    updated_at: 200,
    ...overrides,
  }
}

function render(): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(<RecommendationsTab projectName="portal" />))
  return {
    container,
    cleanup: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10))

describe('RecommendationsTab — Accept button', () => {
  beforeEach(() => {
    fetchRecommendationsMock.mockReset()
    updateRecommendationMock.mockReset()
    applyRecommendationMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders an Accept button only for auto-applicable types', async () => {
    fetchRecommendationsMock.mockResolvedValue({
      recommendations: [
        makeRec({ id: 'rec-known', type: 'agent_schedule_backoff' }),
        makeRec({ id: 'rec-unknown', type: 'some_future_type' }),
      ],
    })
    const { container, cleanup } = render()
    await flush()
    flushSync(() => {})
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim())
    // Expect exactly one "Accept" button (for the schedule rec) and two "dismiss" buttons (one per rec).
    expect(buttons.filter((t) => t === 'Accept')).toHaveLength(1)
    expect(buttons.filter((t) => t === 'dismiss')).toHaveLength(2)
    cleanup()
  })

  it('clicking Accept calls applyRecommendation and reloads', async () => {
    const rec = makeRec()
    fetchRecommendationsMock
      .mockResolvedValueOnce({ recommendations: [rec] })
      .mockResolvedValueOnce({ recommendations: [{ ...rec, status: 'applied' }] })
    applyRecommendationMock.mockResolvedValue({ recommendation: { ...rec, status: 'applied' } })

    const { container, cleanup } = render()
    await flush()
    flushSync(() => {})

    const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Accept')!
    acceptBtn.click()
    await flush()

    expect(applyRecommendationMock).toHaveBeenCalledTimes(1)
    expect(applyRecommendationMock).toHaveBeenCalledWith('portal', expect.objectContaining({ id: 'rec-1' }))
    // Second fetch (reload) happened.
    expect(fetchRecommendationsMock).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('shows an inline error when Accept fails and does NOT mark applied', async () => {
    const rec = makeRec()
    fetchRecommendationsMock.mockResolvedValue({ recommendations: [rec] })
    applyRecommendationMock.mockRejectedValue(new Error('agent endpoint exploded'))

    const { container, cleanup } = render()
    await flush()
    flushSync(() => {})

    const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Accept')!
    acceptBtn.click()
    await flush()

    expect(applyRecommendationMock).toHaveBeenCalledTimes(1)
    expect(updateRecommendationMock).not.toHaveBeenCalled()
    // Error surfaces in the card.
    expect(container.textContent).toContain('agent endpoint exploded')
    cleanup()
  })

  it('shows a load error instead of the empty state when the initial fetch fails', async () => {
    fetchRecommendationsMock.mockRejectedValue(new Error('backend offline'))

    const { container, cleanup } = render()
    await flush()
    flushSync(() => {})

    expect(container.textContent).toContain('Failed to load recommendations.')
    expect(container.textContent).toContain('backend offline')
    expect(container.textContent).not.toContain('No open recommendations')
    cleanup()
  })
})
