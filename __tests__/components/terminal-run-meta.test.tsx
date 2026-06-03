/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TerminalTab } from '@/components/TerminalTab'
import { terminalStore } from '@/lib/terminal/terminal-session-store'

const { replaceMock, pushMock, searchParamsMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pushMock: vi.fn(),
  searchParamsMock: vi.fn(() => new URLSearchParams()),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchSkills: vi.fn().mockResolvedValue({ skills: [] }),
  fetchPersonas: vi.fn().mockResolvedValue({ personas: [] }),
}))

vi.mock('@/hooks/useDocumentVisible', () => ({
  useDocumentVisible: () => true,
}))

vi.mock('@/components/terminal/useSessionManager', () => ({
  useSessionManager: () => ({
    sessions: [],
    loadingSessions: false,
    loadSessions: vi.fn(),
    restoreSession: vi.fn(),
  }),
}))

vi.mock('@/components/terminal/useTerminalBootstrap', () => ({
  useTerminalBootstrap: () => ({ currentReleaseId: null }),
}))

vi.mock('@/components/terminal/useHandleSubmit', () => ({
  useHandleSubmit: () => ({ handleSubmit: vi.fn() }),
}))

vi.mock('@/components/terminal/TerminalToolbar', () => ({
  TerminalToolbar: () => <div data-testid="terminal-toolbar" />,
}))

vi.mock('@/components/terminal/TerminalInput', () => ({
  TerminalInput: () => <div data-testid="terminal-input" />,
}))

vi.mock('@/components/terminal/SessionsPanel', () => ({
  SessionsPanel: () => <div data-testid="sessions-panel" />,
}))

function renderTerminalTab() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<TerminalTab projectName="proj" />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const waitFor = <T,>(cb: () => T | Promise<T>) => vi.waitFor(cb, { interval: 1, timeout: 1000 })

describe('TerminalTab live-run metadata', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    pushMock.mockReset()
    searchParamsMock.mockReset()
    searchParamsMock.mockReturnValue(new URLSearchParams())
    terminalStore.reset('proj')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    terminalStore.reset('proj')
    document.body.innerHTML = ''
  })

  it('clears previous run metadata when the next job lookup fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/settings') {
        return {
          ok: true,
          json: async () => ({ settings: {} }),
        }
      }
      if (url === '/api/jobs/job-1') {
        return {
          ok: true,
          json: async () => ({
            kind: 'agent:review',
            provider: 'codex',
            model: 'smart',
            context_meta: JSON.stringify({ agent: { name: 'Review Agent' } }),
            release_id: null,
          }),
        }
      }
      if (url === '/api/jobs/job-2') {
        return {
          ok: false,
          json: async () => ({ detail: 'not found' }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    terminalStore.update('proj', () => ({
      streaming: true,
      currentJobId: 'job-1',
      streamStartedAt: Date.now(),
    }))

    const { container, unmount } = renderTerminalTab()

    await waitFor(() => {
      expect(container.textContent).toContain('Review Agent')
      expect(container.textContent).toContain('codex · smart')
    })

    terminalStore.update('proj', () => ({
      currentJobId: 'job-2',
    }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-2')
      expect(container.textContent).not.toContain('Review Agent')
      expect(container.textContent).not.toContain('codex · smart')
      expect(container.textContent).toContain('live run')
    })

    unmount()
  })

  it('preserves native textarea resize behavior in the issue close form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/settings') {
        return {
          ok: true,
          json: async () => ({ settings: {} }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    searchParamsMock.mockReturnValue(new URLSearchParams('issue_number=42&issue_repo=owner%2Frepo&issue_title=Bug'))

    const { container, unmount } = renderTerminalTab()
    const closeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Close with verdict')

    flushSync(() => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea')
    expect(textarea?.className).toContain(' resize ')
    expect(textarea?.className).not.toContain('resize-y')

    unmount()
  })
})
