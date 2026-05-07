/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPage } from '@/components/SettingsPage'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  }
}

function renderSettingsPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: 'pipeline' }>, { initialTab: 'pipeline' }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function findInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error(`Label not found: ${labelText}`)
  }
  const wrapper = label.parentElement
  const input = wrapper?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label: ${labelText}`)
  }
  return input
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.includes('Save Settings') || node.textContent?.includes('Saved!'),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Save button not found')
  }
  return button
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SettingsPage', () => {
  beforeEach(() => {
    push.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('rehydrates canonicalized review_fix_max_iterations after save', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const input = findInputByLabel(container, 'Review Fix Loop Iterations')
    flushSync(() => {
      setInputValue(input, '03')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
        method: 'PATCH',
      }))
    })

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect((patchCall?.[1] as RequestInit).body).toContain('"review_fix_max_iterations":"03"')

    unmount()
  })
})
