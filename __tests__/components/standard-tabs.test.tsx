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
})
