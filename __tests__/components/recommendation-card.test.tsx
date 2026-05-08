/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Recommendation } from '@/lib/client-api'
import { RecommendationCard } from '@/components/recommendations/RecommendationCard'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    project: 'alpha/core',
    source_kind: 'agent:tests',
    source_id: 'job-1',
    agent_id: 'agent-1',
    agent_name: 'tests',
    type: 'agent_schedule_backoff',
    title: 'Back off schedule',
    detail: 'No actionable work found.',
    status: 'open',
    payload: { currentSchedule: '4h', recommendedSchedule: '8h' },
    created_at: 100,
    updated_at: 200,
    ...overrides,
  }
}

function renderCard(overrides: Partial<React.ComponentProps<typeof RecommendationCard>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const props: React.ComponentProps<typeof RecommendationCard> = {
    item: makeRecommendation(),
    busy: false,
    errorMessage: null,
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    showProjectLink: false,
    ...overrides,
  }

  flushSync(() => {
    root.render(<RecommendationCard {...props} />)
  })

  return {
    container,
    props,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('RecommendationCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders accept controls, schedule details, and a project link for auto-applicable recommendations', () => {
    const { container, unmount } = renderCard({ showProjectLink: true })

    const link = container.querySelector('a')
    if (!(link instanceof HTMLAnchorElement)) throw new Error('project link not found')

    expect(container.textContent).toContain('Accept')
    expect(container.textContent).toContain('dismiss')
    expect(container.textContent).toContain('current 4h / suggested 8h')
    expect(container.textContent).toContain('agent:tests')
    expect(link.getAttribute('href')).toBe('/project/alpha%2Fcore/recommendations')
    expect(link.textContent).toBe('alpha/core →')

    unmount()
  })

  it('hides accept for non-auto-applicable recommendations and surfaces inline errors', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ type: 'some_future_type', payload: null }),
      errorMessage: 'apply failed',
    })

    expect(container.textContent).not.toContain('Accept')
    expect(container.textContent).toContain('dismiss')
    expect(container.textContent).toContain('apply failed')

    unmount()
  })

  it('disables actions and shows the busy label while an apply is in flight', () => {
    const { container, unmount } = renderCard({ busy: true })

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(container.textContent).toContain('applying…')

    unmount()
  })
})
