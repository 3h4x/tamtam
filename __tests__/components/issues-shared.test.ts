/* @vitest-environment jsdom */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CheckIcon, GateBadge, Labels } from '@/components/issues-tab/shared'

function renderNode(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (next: React.ReactElement) => {
    flushSync(() => {
      root.render(next)
    })
  }

  render(node)

  return {
    container,
    render,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('issues-tab shared components', () => {
  it('limits visible labels and shows a +N overflow chip with the hidden names', () => {
    const { container, unmount } = renderNode(React.createElement(Labels, {
      labels: [
        { name: 'bug', color: 'ff0000' },
        { name: 'ux', color: '00ff00' },
        { name: 'backend', color: '0000ff' },
      ],
      limit: 2,
    }))

    expect(container.textContent).toContain('bug')
    expect(container.textContent).toContain('ux')
    expect(container.textContent).not.toContain('backend')
    expect(container.querySelector('[title="backend"]')?.textContent).toBe('+1')
    unmount()
  })

  it('renders clickable gate badges and blocks the handler while busy', () => {
    const onClick = vi.fn()
    const { container, render, unmount } = renderNode(React.createElement(GateBadge, {
      label: 'DoD',
      state: 'warn',
      title: 'run dod',
      onClick,
    }))

    const button = container.querySelector('button')
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)

    render(React.createElement(GateBadge, {
      label: 'DoD',
      state: 'warn',
      title: 'run dod',
      onClick,
      busy: true,
    }))

    const busyButton = container.querySelector('button') as HTMLButtonElement | null
    expect(busyButton?.disabled).toBe(true)
    expect(container.textContent).toContain('⟳')
    busyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('shows the spinner icon for pending checks and the check mark for successful checks', () => {
    const { container, render, unmount } = renderNode(React.createElement(CheckIcon, {
      conclusion: null,
      status: 'PENDING',
    }))

    expect(container.querySelector('.animate-spin')).toBeTruthy()

    render(React.createElement(CheckIcon, {
      conclusion: 'SUCCESS',
      status: 'COMPLETED',
    }))

    expect(container.querySelector('.animate-spin')).toBeNull()
    unmount()
  })
})
