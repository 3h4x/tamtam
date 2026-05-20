/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RecommendedAgents } from '@/components/agents-tab/RecommendedAgents'

const testAddTemplate = {
  name: 'test-add',
  aliases: ['tests'],
  description: 'Adds missing tests.',
  model: 'normal',
  schedule: '24h',
  prompt: '',
  skillIds: ['agent-tests'],
}

const releaseGateTemplate = {
  name: 'release-gate',
  description: 'Checks release readiness.',
  model: 'normal',
  schedule: '12h',
  prompt: '',
  skillIds: ['release-review'],
  essential: true,
}

const syncTemplate = {
  name: 'sync-watch',
  description: 'Tracks cross-project drift.',
  model: 'normal',
  schedule: '48h',
  prompt: '',
}

const issueCruncherTemplate = {
  name: 'issue-cruncher',
  description: 'Picks a ready-to-go issue.',
  model: 'normal',
  schedule: '',
  prompt: '',
  skillIds: ['agent-issue-cruncher'],
  featured: true,
}

const customCoverageTemplate = {
  name: 'project-coverage',
  description: 'Runs project-specific checks.',
  model: 'normal',
  schedule: '24h',
  prompt: '',
}

function recommendedOnlyTemplate(index: number) {
  return {
    name: `coverage-${index}`,
    description: `Coverage recommendation ${index}.`,
    model: 'normal',
    schedule: '24h',
    prompt: '',
    skillIds: ['agent-tests'],
  }
}

function renderRecommendedAgents(
  props: Partial<React.ComponentProps<typeof RecommendedAgents>> = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(
      <RecommendedAgents
        agents={[]}
        customTemplates={[]}
        recommendedAgents={[testAddTemplate]}
        onAddAgent={vi.fn()}
        {...props}
      />,
    )
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('RecommendedAgents', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('suppresses the renamed test-add recommendation when a legacy tests agent exists', () => {
    const { container, unmount } = renderRecommendedAgents({
      agents: [{ name: 'tests' }],
    })

    expect(container.textContent).not.toContain('test-add')

    unmount()
  })

  it('lets a legacy tests custom template override the renamed test-add recommendation', () => {
    const { container, unmount } = renderRecommendedAgents({
      customTemplates: [{
        name: 'tests',
        description: 'Custom test agent.',
        model: 'normal',
        schedule: '24h',
        prompt: 'Write project-specific tests.',
      }],
    })

    expect(container.textContent).toContain('tests')
    expect(container.textContent).toContain('custom')
    expect(container.textContent).not.toContain('test-add')

    unmount()
  })

  it('shows legacy alias names on the built-in recommendation card', () => {
    const { container, unmount } = renderRecommendedAgents()

    expect(container.textContent).toContain('legacy: tests')
    expect(container.textContent).toContain('Use template')

    unmount()
  })

  it('shows on-demand metadata for unscheduled templates', () => {
    const { container, unmount } = renderRecommendedAgents({
      recommendedAgents: [issueCruncherTemplate],
    })

    const badgeTexts = Array.from(container.querySelectorAll('span')).map(node => node.textContent)

    expect(badgeTexts).toContain('on demand')

    unmount()
  })

  it('renders compact recommendation metadata as separate badges', () => {
    const { container, unmount } = renderRecommendedAgents()
    const badgeTexts = Array.from(container.querySelectorAll('span')).map(node => node.textContent)

    expect(badgeTexts).toContain('Normal')
    expect(badgeTexts).toContain('1 skill')
    expect(badgeTexts).toContain('every 24h')

    unmount()
  })

  it('collapses non-priority recommendations until expanded when priority templates exist', () => {
    const { container, unmount } = renderRecommendedAgents({
      recommendedAgents: [releaseGateTemplate, testAddTemplate, syncTemplate],
    })

    expect(container.textContent).toContain('release-gate')
    expect(container.textContent).toContain('test-add')
    expect(container.textContent).toContain('sync-watch')
    expect(container.textContent).toContain('Optional templates')
    expect(container.textContent).toContain('Show 2 templates')
    expect(container.textContent).toContain('2 templates stay hidden until this project needs broader coverage.')
    expect(container.textContent).not.toContain('Adds missing tests.')
    expect(container.textContent).not.toContain('legacy: tests')

    unmount()
  })

  it('uses singular copy when one non-priority recommendation is collapsed', () => {
    const { container, unmount } = renderRecommendedAgents({
      recommendedAgents: [releaseGateTemplate, testAddTemplate],
    })

    expect(container.textContent).toContain('Show 1 template')
    expect(container.textContent).toContain('1 template stays hidden until this project needs broader coverage.')
    expect(container.textContent).not.toContain('Show 1 templates')

    unmount()
  })

  it('keeps custom recommended templates visible when priority templates exist', () => {
    const { container, unmount } = renderRecommendedAgents({
      customTemplates: [customCoverageTemplate],
      recommendedAgents: [releaseGateTemplate, testAddTemplate, syncTemplate],
    })

    expect(container.textContent).toContain('project-coverage')
    expect(container.textContent).toContain('Runs project-specific checks.')
    expect(container.textContent).toContain('Custom templates stay visible; built-in options stay collapsed until you ask for broader coverage.')
    expect(container.textContent).toContain('Show 2 more')
    expect(container.textContent).not.toContain('Adds missing tests.')
    expect(container.textContent).not.toContain('Tracks cross-project drift.')

    unmount()
  })

  it('keeps the collapse control after expanding a recommended-only list', () => {
    const { container, unmount } = renderRecommendedAgents({
      recommendedAgents: Array.from({ length: 5 }, (_, index) => recommendedOnlyTemplate(index + 1)),
    })

    expect(container.textContent).toContain('Show 1 more')
    expect(container.textContent).toContain('coverage-1')
    expect(container.textContent).toContain('coverage-4')
    expect(container.textContent).not.toContain('coverage-5')

    const showMore = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Show 1 more')
    expect(showMore).toBeTruthy()

    flushSync(() => {
      showMore?.click()
    })

    expect(container.textContent).toContain('coverage-5')
    expect(container.textContent).toContain('Show fewer')

    const showFewer = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Show fewer')
    expect(showFewer).toBeTruthy()

    flushSync(() => {
      showFewer?.click()
    })

    expect(container.textContent).not.toContain('coverage-5')
    expect(container.textContent).toContain('Show 1 more')

    unmount()
  })
})
