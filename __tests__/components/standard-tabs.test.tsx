/* @vitest-environment jsdom */

import React, { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { StandardTabs } from '@/components/ui/StandardTabs'

function TabsHarness() {
  const [active, setActive] = useState<'agents' | 'skills'>('agents')
  return (
    <StandardTabs
      items={[
        { id: 'agents', label: 'Agents' },
        { id: 'skills', label: 'Skills' },
      ]}
      activeTab={active}
      ariaLabel="Library section"
      onChange={setActive}
    />
  )
}

function SemanticTabsHarness() {
  const [active, setActive] = useState<'unresolved' | 'history'>('unresolved')
  return (
    <StandardTabs
      items={[
        { id: 'unresolved', label: 'Unresolved' },
        { id: 'history', label: 'History' },
      ]}
      activeTab={active}
      ariaLabel="Recommendations"
      variant="tabs"
      onChange={setActive}
    />
  )
}

function renderTabs() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<TabsHarness />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function renderSemanticTabs() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<SemanticTabsHarness />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('StandardTabs', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exposes the active tab with aria-current after tab changes', () => {
    const { container, unmount } = renderTabs()
    const agents = container.querySelector<HTMLButtonElement>('button:nth-of-type(1)')
    const skills = container.querySelector<HTMLButtonElement>('button:nth-of-type(2)')

    expect(agents?.getAttribute('aria-current')).toBe('page')
    expect(skills?.getAttribute('aria-current')).toBeNull()

    flushSync(() => {
      skills?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(agents?.getAttribute('aria-current')).toBeNull()
    expect(skills?.getAttribute('aria-current')).toBe('page')

    unmount()
  })

  it('can expose in-page tab semantics after tab changes', () => {
    const { container, unmount } = renderSemanticTabs()
    const tablist = container.querySelector('[role="tablist"]')
    const unresolved = container.querySelector<HTMLButtonElement>('button:nth-of-type(1)')
    const history = container.querySelector<HTMLButtonElement>('button:nth-of-type(2)')

    expect(tablist?.getAttribute('aria-label')).toBe('Recommendations')
    expect(unresolved?.getAttribute('role')).toBe('tab')
    expect(history?.getAttribute('role')).toBe('tab')
    expect(unresolved?.getAttribute('aria-selected')).toBe('true')
    expect(history?.getAttribute('aria-selected')).toBe('false')
    expect(unresolved?.getAttribute('aria-current')).toBeNull()

    flushSync(() => {
      history?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(unresolved?.getAttribute('aria-selected')).toBe('false')
    expect(history?.getAttribute('aria-selected')).toBe('true')
    expect(history?.getAttribute('aria-current')).toBeNull()

    unmount()
  })
})
