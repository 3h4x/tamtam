/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Recommendation } from '@/lib/client-api'
import { isAutoRecommendation } from '@/lib/client-api'
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
    onRunNow: vi.fn(),
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

  it('classifies orchestrator informational recommendations as auto', () => {
    expect(isAutoRecommendation('orchestrator_boost')).toBe(true)
    expect(isAutoRecommendation('agent_unfruitful')).toBe(true)
    expect(isAutoRecommendation('orchestrator_agent_health')).toBe(true)
    expect(isAutoRecommendation('agent_schedule_backoff')).toBe(false)
  })

  it('renders a Fix menu with apply, schedule details, and a project link for auto-applicable recommendations', () => {
    const { container, unmount } = renderCard({ showProjectLink: true })

    const projectLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('alpha/core'))
    if (!(projectLink instanceof HTMLAnchorElement)) throw new Error('project link not found')

    expect(container.textContent).toContain('Fix')
    expect(container.textContent).toContain('Apply suggested change')
    expect(container.textContent).toContain('Run agent now')
    expect(container.textContent).toContain('Edit agent')
    expect(container.textContent).toContain('dismiss')
    expect(container.textContent).toContain('current 4h / suggested 8h')
    expect(container.textContent).toContain('agent:tests')
    expect(projectLink.getAttribute('href')).toBe('/project/alpha%2Fcore')

    // Edit agent link points at the agent editor for this agent
    const editLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('Edit agent'))
    expect(editLink?.getAttribute('href')).toBe('/project/alpha%2Fcore/agents?agent=agent-1')

    unmount()
  })

  it('renders schedule recommendation reasoning when present', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        payload: {
          currentSchedule: '1h',
          recommendedSchedule: '8h',
          reasoning: {
            summary: 'No coverage gaps found.',
            actionableWork: false,
            filesChangedCount: 0,
            currentSchedule: '1h',
            recommendedSchedule: '8h',
            confidence: 'high',
            sourceJobId: 'job-42',
          },
        },
      }),
    })

    expect(container.textContent).toContain('Why')
    expect(container.textContent).toContain('summary')
    expect(container.textContent).toContain('No coverage gaps found.')
    expect(container.textContent).toContain('actionable work')
    expect(container.textContent).toContain('no')
    expect(container.textContent).toContain('files changed')
    expect(container.textContent).toContain('cadence')
    expect(container.textContent).toContain('1h → 8h')
    expect(container.textContent).toContain('confidence')
    expect(container.textContent).toContain('high')
    expect(container.textContent).toContain('source job')
    expect(container.textContent).toContain('job-42')

    unmount()
  })

  it('renders older schedule recommendations without reasoning metadata', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ payload: { currentSchedule: '4h', recommendedSchedule: '8h' } }),
    })

    expect(container.textContent).toContain('current 4h / suggested 8h')
    expect(container.textContent).not.toContain('Why')
    expect(container.textContent).toContain('Apply suggested change')
    expect(container.textContent).toContain('dismiss')

    unmount()
  })

  it('omits "apply" but still offers Fix actions for non-auto-applicable manual recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ type: 'some_future_type', payload: null }),
      errorMessage: 'apply failed',
    })

    // Not auto-applicable → no "Apply suggested change", but still a manual
    // recommendation with an agent → Fix menu offers Run/Edit.
    expect(container.textContent).not.toContain('Apply suggested change')
    expect(container.textContent).toContain('Fix')
    expect(container.textContent).toContain('Run agent now')
    expect(container.textContent).toContain('Edit agent')
    expect(container.textContent).toContain('dismiss')
    expect(container.textContent).toContain('apply failed')

    unmount()
  })

  it('shows AUTO pill and no Fix menu for orchestrator boost recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ source_kind: 'orchestrator', type: 'orchestrator_boost', title: 'Boosted improve' }),
    })

    expect(container.textContent).toContain('AUTO')
    expect(container.textContent).toContain('boost')
    // AUTO recommendations are informational — no Fix, no apply, dismiss only.
    expect(container.textContent).not.toContain('Fix')
    expect(container.textContent).not.toContain('Apply suggested change')
    expect(container.textContent).toContain('dismiss')

    unmount()
  })

  it('shows AUTO pill and no Fix menu for unfruitful recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ source_kind: 'agent:tests', type: 'agent_unfruitful', title: "tests isn't producing changes" }),
    })

    expect(container.textContent).toContain('AUTO')
    expect(container.textContent).toContain('unfruitful')
    expect(container.textContent).not.toContain('Fix')
    expect(container.textContent).toContain('dismiss')

    unmount()
  })

  it('renders health metrics for orchestrator_agent_health recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        source_kind: 'orchestrator',
        type: 'orchestrator_agent_health',
        title: 'improve — loop detected',
        detail: 'Agent keeps touching the same file. Review the prompt scope.',
        payload: {
          concern: true,
          concernType: 'loop',
          severity: 'high',
          runsAnalyzed: 3,
          lastRunScore: 42,
          avgRunScore: 38.7,
        },
      }),
    })

    expect(container.textContent).toContain('AUTO')
    expect(container.textContent).toContain('health')
    expect(container.textContent).toContain('concern')
    expect(container.textContent).toContain('loop')
    expect(container.textContent).toContain('severity')
    expect(container.textContent).toContain('high')
    expect(container.textContent).toContain('last score')
    expect(container.textContent).toContain('42/100')
    expect(container.textContent).toContain('avg score')
    expect(container.textContent).toContain('39/100')
    // Health recommendations are informational: AUTO pill, no Fix or Accept actions.
    expect(container.textContent).not.toContain('Accept')
    expect(container.textContent).not.toContain('Fix')

    unmount()
  })

  it('does not show AUTO pill for agent-sourced recommendations', () => {
    const { container, unmount } = renderCard()

    expect(container.textContent).not.toContain('AUTO')

    unmount()
  })

  it('disables actions and shows the busy label while a Fix action is in flight', () => {
    const { container, unmount } = renderCard({ busy: true })

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(container.textContent).toContain('working…')

    unmount()
  })

  it('fires onRunNow when the Run agent now Fix action is clicked', () => {
    const onRunNow = vi.fn()
    // default item is agent_schedule_backoff → a manual recommendation with a Fix menu
    const { container, unmount } = renderCard({ onRunNow })

    const runBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Run agent now')
    runBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onRunNow).toHaveBeenCalledOnce()

    unmount()
  })

  it('fires onAccept when the Apply suggested change Fix action is clicked', () => {
    const onAccept = vi.fn()
    const { container, unmount } = renderCard({ onAccept })

    const applyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Apply suggested change')
    applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onAccept).toHaveBeenCalledOnce()

    unmount()
  })
})
