/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentsPage } from '@/components/AgentsPage'

const { pushMock, fetchAgentsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchAgents: fetchAgentsMock,
}))

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(AgentsPage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim().startsWith(text))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('AgentsPage', () => {
  beforeEach(() => {
    pushMock.mockReset()
    fetchAgentsMock.mockReset()
    fetchAgentsMock.mockResolvedValue({
      agents: [{
        id: 'agent-1',
        name: 'Docs',
        project: 'alpha',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: 'Run docs',
        schedule: null,
        enabled: true,
      }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ internal: { entries: [] } }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows a reset action when a filter has no matching agents', async () => {
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Docs')
      expect(buttonByText(container, 'Active')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Active').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No active scheduled agents')
      expect(buttonByText(container, 'Show all agents')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Show all agents').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Docs')
    })

    unmount()
  })
})
