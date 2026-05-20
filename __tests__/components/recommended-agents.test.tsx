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

    expect(container.textContent).toContain('legacy name tests')
    expect(container.textContent).toContain('Use template')

    unmount()
  })
})
