/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Recommendation } from '@/lib/client-api'
import { isAutoRecommendation, isManualRecommendation } from '@/lib/client-api'
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
    onBackOff: vi.fn(),
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

  it('classifies AUTO as orchestrator-resolved and MANUAL as operator-actionable', () => {
    // AUTO = orchestrator resolves it end-to-end (only boost). Everything the
    // operator must act on is MANUAL, even though the orchestrator detected it.
    expect(isAutoRecommendation('orchestrator_boost')).toBe(true)
    expect(isAutoRecommendation('agent_unfruitful')).toBe(false)
    expect(isAutoRecommendation('orchestrator_agent_health')).toBe(false)
    expect(isAutoRecommendation('agent_schedule_backoff')).toBe(false)

    expect(isManualRecommendation('agent_unfruitful')).toBe(true)
    expect(isManualRecommendation('orchestrator_agent_health')).toBe(true)
    expect(isManualRecommendation('agent_schedule_backoff')).toBe(true)
    expect(isManualRecommendation('orchestrator_boost')).toBe(false)
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

  it('omits "apply" but still offers Fix actions for manual recommendations that are not auto-applicable', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ type: 'agent_unfruitful', payload: null }),
      errorMessage: 'apply failed',
    })

    // Manual + not auto-applicable → no "Apply suggested change", but still a
    // manual recommendation with an agent → Fix menu offers Run/Edit.
    expect(container.textContent).not.toContain('Apply suggested change')
    expect(container.textContent).toContain('Fix')
    expect(container.textContent).toContain('Run agent now')
    expect(container.textContent).toContain('Edit agent')
    expect(container.textContent).toContain('dismiss')
    expect(container.textContent).toContain('apply failed')

    unmount()
  })

  it('shows no badge and no Fix menu for an unclassified recommendation type', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ type: 'some_future_type', payload: null }),
    })

    // Unknown types are neither AUTO nor MANUAL → no pill, no Fix menu (dismiss only).
    expect(container.textContent).not.toContain('AUTO')
    expect(container.textContent).not.toContain('MANUAL')
    expect(container.textContent).not.toContain('Fix')
    expect(container.textContent).toContain('dismiss')

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

  it('shows a MANUAL pill and an actionable Fix menu for unfruitful recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({ source_kind: 'agent:tests', type: 'agent_unfruitful', title: "tests isn't producing changes" }),
      onInvestigate: vi.fn(),
      onStopBoosting: vi.fn(),
      onDisable: vi.fn(),
    })

    // Unfruitful is auto-*detected* but the remediation is the operator's, so it
    // carries a MANUAL pill (not AUTO) and surfaces remediation as Fix buttons.
    expect(container.textContent).toContain('MANUAL')
    expect(container.textContent).not.toContain('AUTO')
    expect(container.textContent).toContain('unfruitful')
    expect(container.textContent).toContain('Fix')
    expect(container.textContent).toContain('Run agent now')
    expect(container.textContent).toContain('Run investigation')
    expect(container.textContent).toContain('Decrease rate')
    expect(container.textContent).toContain('Stop boosting')
    expect(container.textContent).toContain('Disable agent')
    expect(container.textContent).toContain('Edit agent')
    // Not auto-applicable → no dedicated "Apply suggested change".
    expect(container.textContent).not.toContain('Apply suggested change')
    expect(container.textContent).toContain('dismiss')

    unmount()
  })

  it('links "View logs" to the source job that produced the recommendation', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '15m', sourceJobId: 'job-77' },
      }),
    })

    const logsLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('View logs'))
    expect(logsLink?.getAttribute('href')).toBe('/project/alpha%2Fcore/terminal?job=job-77')

    unmount()
  })

  it('omits "View logs" when the payload has no source job', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '15m' },
      }),
    })

    expect(container.textContent).not.toContain('View logs')

    unmount()
  })

  it('fires onInvestigate, onStopBoosting, and onDisable from the Fix menu', () => {
    const onInvestigate = vi.fn()
    const onStopBoosting = vi.fn()
    const onDisable = vi.fn()
    const { container, unmount } = renderCard({
      item: makeRecommendation({ source_kind: 'agent:tests', type: 'agent_unfruitful', title: "tests isn't producing changes" }),
      onInvestigate,
      onStopBoosting,
      onDisable,
    })

    const click = (label: string) =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === label)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    click('Run investigation')
    click('Stop boosting')
    click('Disable agent')

    expect(onInvestigate).toHaveBeenCalledOnce()
    expect(onStopBoosting).toHaveBeenCalledOnce()
    expect(onDisable).toHaveBeenCalledOnce()

    unmount()
  })

  it('hides agent-management actions for system-agent recommendations', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        agent_id: 'system:alpha:documentation-reindex-vectors',
        source_kind: 'agent:documentation-reindex-vectors',
        type: 'agent_unfruitful',
        title: "documentation-reindex-vectors isn't producing changes",
      }),
      onInvestigate: vi.fn(),
      onStopBoosting: vi.fn(),
      onDisable: vi.fn(),
    })

    expect(container.textContent).toContain('Fix')
    expect(container.textContent).toContain('Run agent now')
    // System agents aren't user-editable — no schedule/boost/disable controls.
    expect(container.textContent).not.toContain('Decrease rate')
    expect(container.textContent).not.toContain('Run investigation')
    expect(container.textContent).not.toContain('Stop boosting')
    expect(container.textContent).not.toContain('Disable agent')

    unmount()
  })

  it('hides boost and disable controls when local payload state says they already changed', () => {
    const stopped = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '15m', boostable: false },
      }),
      onInvestigate: vi.fn(),
      onStopBoosting: vi.fn(),
      onDisable: vi.fn(),
    })
    expect(stopped.container.textContent).toContain('Run investigation')
    expect(stopped.container.textContent).not.toContain('Stop boosting')
    expect(stopped.container.textContent).toContain('Disable agent')
    stopped.unmount()

    const disabled = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '15m', enabled: false },
      }),
      onInvestigate: vi.fn(),
      onStopBoosting: vi.fn(),
      onDisable: vi.fn(),
    })
    expect(disabled.container.textContent).not.toContain('Run agent now')
    expect(disabled.container.textContent).not.toContain('Run investigation')
    expect(disabled.container.textContent).not.toContain('Stop boosting')
    expect(disabled.container.textContent).not.toContain('Disable agent')
    expect(disabled.container.textContent).toContain('Edit agent')
    disabled.unmount()
  })

  it('fires onBackOff with the next-slower cadence when Decrease rate is clicked', () => {
    const onBackOff = vi.fn()
    const { container, unmount } = renderCard({
      item: makeRecommendation({ source_kind: 'agent:tests', type: 'agent_unfruitful', title: "tests isn't producing changes" }),
      onBackOff,
    })

    const backOffBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Decrease rate')
    backOffBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onBackOff).toHaveBeenCalledOnce()
    // default payload currentSchedule is '4h' → next ladder rung is '8h'
    expect(onBackOff).toHaveBeenCalledWith('8h')

    unmount()
  })

  it('hides Decrease rate only once the agent is at the slowest cadence', () => {
    const slower = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '24h' },
      }),
    })
    // 24h still has a slower rung (7d), so Decrease rate stays available.
    expect(slower.container.textContent).toContain('Decrease rate')
    slower.unmount()

    const slowest = renderCard({
      item: makeRecommendation({
        source_kind: 'agent:tests',
        type: 'agent_unfruitful',
        title: "tests isn't producing changes",
        payload: { currentSchedule: '7d' },
      }),
    })
    expect(slowest.container.textContent).toContain('Fix')
    expect(slowest.container.textContent).not.toContain('Decrease rate')
    slowest.unmount()
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

    expect(container.textContent).toContain('health')
    expect(container.textContent).toContain('concern')
    expect(container.textContent).toContain('loop')
    expect(container.textContent).toContain('severity')
    expect(container.textContent).toContain('high')
    expect(container.textContent).toContain('last score')
    expect(container.textContent).toContain('42/100')
    expect(container.textContent).toContain('avg score')
    expect(container.textContent).toContain('39/100')
    // Health is MANUAL: the orchestrator only diagnosed it, so it carries the
    // MANUAL pill and a Fix menu (narrow scope → Edit, throttle → Decrease rate).
    expect(container.textContent).toContain('MANUAL')
    expect(container.textContent).not.toContain('AUTO')
    expect(container.textContent).toContain('Fix')

    unmount()
  })

  it('offers a Fix menu (Edit + Decrease rate) on a health recommendation', () => {
    const { container, unmount } = renderCard({
      item: makeRecommendation({
        source_kind: 'orchestrator',
        type: 'orchestrator_agent_health',
        title: 'improve — noise detected',
        payload: { concern: true, concernType: 'noise', severity: 'low' },
      }),
    })

    const labels = Array.from(container.querySelectorAll('button,a')).map((n) => n.textContent)
    expect(labels).toContain('Decrease rate') // health with no schedule defaults to 8h
    expect(labels.some((l) => l?.includes('Edit agent'))).toBe(true)

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
