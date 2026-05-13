/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ThemeToggle } from '@/components/ThemeToggle'

const { useThemeMock, setThemeMock } = vi.hoisted(() => ({
  useThemeMock: vi.fn(),
  setThemeMock: vi.fn(),
}))

vi.mock('@/hooks/useTheme', () => ({
  useTheme: useThemeMock,
}))

function renderThemeToggle() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ThemeToggle))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    useThemeMock.mockReset()
    setThemeMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders through its client entrypoint and toggles from light to dark', () => {
    useThemeMock.mockReturnValue({ theme: 'light', setTheme: setThemeMock })

    const { container, unmount } = renderThemeToggle()
    const button = container.querySelector('button')

    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(button?.getAttribute('aria-label')).toBe('Switch to dark mode')

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(setThemeMock).toHaveBeenCalledWith('dark')

    unmount()
  })
})
