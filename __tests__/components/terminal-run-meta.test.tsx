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

const {
  fetchAgentsMock,
  fetchCustomActionsMock,
  fetchIssuesAndPRsMock,
  fetchProjectDocsMock,
  fetchSkillsMock,
  fetchPersonasMock,
  releaseProjectMock,
  runCustomActionMock,
  testProjectMock,
  terminalInputMock,
} = vi.hoisted(() => ({
  fetchAgentsMock: vi.fn().mockResolvedValue({ agents: [] }),
  fetchCustomActionsMock: vi.fn().mockResolvedValue({ actions: [] }),
  fetchIssuesAndPRsMock: vi.fn().mockResolvedValue({ issues: [] }),
  fetchProjectDocsMock: vi.fn().mockResolvedValue({ docs: [] }),
  fetchSkillsMock: vi.fn().mockResolvedValue({ skills: [] }),
  fetchPersonasMock: vi.fn().mockResolvedValue({ personas: [] }),
  releaseProjectMock: vi.fn(),
  runCustomActionMock: vi.fn(),
  testProjectMock: vi.fn(),
  terminalInputMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchAgents: fetchAgentsMock,
  fetchCustomActions: fetchCustomActionsMock,
  fetchIssuesAndPRs: fetchIssuesAndPRsMock,
  fetchProjectDocs: fetchProjectDocsMock,
  fetchSkills: fetchSkillsMock,
  fetchPersonas: fetchPersonasMock,
  releaseProject: releaseProjectMock,
  runCustomAction: runCustomActionMock,
  testProject: testProjectMock,
  fetchSettings: vi.fn().mockResolvedValue({ settings: {} }),
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
  TerminalInput: (props: unknown) => {
    terminalInputMock(props)
    return <div data-testid="terminal-input" />
  },
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
    fetchAgentsMock.mockReset()
    fetchAgentsMock.mockResolvedValue({ agents: [] })
    fetchCustomActionsMock.mockReset()
    fetchCustomActionsMock.mockResolvedValue({ actions: [] })
    fetchIssuesAndPRsMock.mockReset()
    fetchIssuesAndPRsMock.mockResolvedValue({ issues: [] })
    fetchProjectDocsMock.mockReset()
    fetchProjectDocsMock.mockResolvedValue({ docs: [] })
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ skills: [] })
    fetchPersonasMock.mockReset()
    fetchPersonasMock.mockResolvedValue({ personas: [] })
    releaseProjectMock.mockReset()
    runCustomActionMock.mockReset()
    testProjectMock.mockReset()
    terminalInputMock.mockReset()
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

  it('streams slash-started non-Claude jobs in passthrough mode', async () => {
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
    fetchCustomActionsMock.mockResolvedValue({
      actions: [{ name: 'Deploy', command: 'pnpm deploy' }],
    })
    runCustomActionMock.mockResolvedValue({ status: 'started', job_id: 'action-job', pid: 1 })
    testProjectMock.mockResolvedValue({ status: 'started', job_id: 'test-job', pid: 2, log_path: '/tmp/test.log' })
    releaseProjectMock.mockResolvedValue({ status: 'started', release_job_id: 'release-job', message: 'started' })
    const startStreamMock = vi.spyOn(terminalStore, 'startStream').mockImplementation(() => {})

    const { unmount } = renderTerminalTab()

    await waitFor(() => {
      const latestProps = terminalInputMock.mock.calls.at(-1)?.[0] as {
        slashCommands?: Array<{ id: string }>
      }
      expect(latestProps.slashCommands).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'builtin:test' }),
        expect.objectContaining({ id: 'builtin:release' }),
        expect.objectContaining({ id: 'action:Deploy' }),
      ]))
    })

    const latestProps = terminalInputMock.mock.calls.at(-1)?.[0] as {
      slashCommands: Array<{ id: string }>
      onSlashCommandSelect: (command: { id: string }) => Promise<void>
    }
    const testCommand = latestProps.slashCommands.find((command) => command.id === 'builtin:test')
    const releaseCommand = latestProps.slashCommands.find((command) => command.id === 'builtin:release')
    const actionCommand = latestProps.slashCommands.find((command) => command.id === 'action:Deploy')

    await latestProps.onSlashCommandSelect(actionCommand!)
    await latestProps.onSlashCommandSelect(testCommand!)
    await latestProps.onSlashCommandSelect(releaseCommand!)

    expect(startStreamMock).toHaveBeenCalledWith('proj', 'action-job', false, true)
    expect(startStreamMock).toHaveBeenCalledWith('proj', 'test-job', false, true)
    expect(startStreamMock).toHaveBeenCalledWith('proj', 'release-job', false, true)

    startStreamMock.mockRestore()
    unmount()
  })

  it('toggles slash-selected skills and docs without duplicating attachments', async () => {
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
    fetchSkillsMock.mockResolvedValue({
      skills: [{ id: 'reviewer', name: 'reviewer', description: 'review code', content: 'review instructions' }],
    })
    fetchProjectDocsMock.mockResolvedValue({
      docs: [{ name: 'README.md', content: '# readme' }],
    })

    const { unmount } = renderTerminalTab()

    await waitFor(() => {
      const latestProps = terminalInputMock.mock.calls.at(-1)?.[0] as {
        slashCommands?: Array<{ id: string }>
      }
      expect(latestProps.slashCommands).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'skill:reviewer' }),
        expect.objectContaining({ id: 'doc:README.md' }),
      ]))
    })

    const latestProps = terminalInputMock.mock.calls.at(-1)?.[0] as {
      slashCommands: Array<{ id: string }>
      onSlashCommandSelect: (command: { id: string }) => Promise<void>
    }
    const skillCommand = latestProps.slashCommands.find((command) => command.id === 'skill:reviewer')
    const docCommand = latestProps.slashCommands.find((command) => command.id === 'doc:README.md')

    await latestProps.onSlashCommandSelect(skillCommand!)
    expect(terminalStore.get('proj').selectedItems.map((item) => item.id)).toEqual(['reviewer'])

    await latestProps.onSlashCommandSelect(skillCommand!)
    expect(terminalStore.get('proj').selectedItems).toEqual([])

    await latestProps.onSlashCommandSelect(docCommand!)
    expect(terminalStore.get('proj').selectedDocs.map((doc) => doc.name)).toEqual(['README.md'])

    await latestProps.onSlashCommandSelect(docCommand!)
    expect(terminalStore.get('proj').selectedDocs).toEqual([])

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
