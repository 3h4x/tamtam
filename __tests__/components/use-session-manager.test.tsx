/* @vitest-environment jsdom */

import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useSessionManager } from '@/components/terminal/useSessionManager'
import { terminalStore, type TermEntry } from '@/lib/terminal/terminal-session-store'
import type { SessionItem } from '@/components/terminal/SessionsPanel'

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}))

const startStreamMock = vi.spyOn(terminalStore, 'startStream').mockImplementation(() => {})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

function renderElement(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(element)
  })

  return {
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function SessionManagerHarness({
  onReady,
}: {
  onReady: (controls: {
    loadSessions: () => Promise<void>
    restoreSession: (session: SessionItem) => Promise<void>
    getSessions: () => SessionItem[]
    isLoading: () => boolean
  }) => void
}) {
  const manager = useSessionManager('proj')

  useEffect(() => {
    onReady({
      loadSessions: manager.loadSessions,
      restoreSession: manager.restoreSession,
      getSessions: () => manager.sessions,
      isLoading: () => manager.loadingSessions,
    })
  }, [manager, onReady])

  return null
}

describe('useSessionManager', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    startStreamMock.mockClear()
    terminalStore.reset('proj')
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    terminalStore.reset('proj')
    document.body.innerHTML = ''
  })

  it('groups recent jobs by session id using the earliest prompt and latest status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        jobs: [
          {
            id: 'job-newest',
            kind: 'run',
            status: 'done',
            session_id: 'sess-1',
            started_at: 300,
            finished_at: 320,
            exit_code: 0,
            user_prompt: null,
            prompt: 'follow-up prompt',
            context_meta: null,
          },
          {
            id: 'job-oldest',
            kind: 'run',
            status: 'done',
            session_id: 'sess-1',
            started_at: 100,
            finished_at: 120,
            exit_code: 0,
            user_prompt: 'original prompt',
            prompt: 'backup prompt',
            context_meta: null,
          },
          {
            id: 'agent-job',
            kind: 'agent:nightly',
            status: 'running',
            session_id: 'sess-2',
            started_at: 250,
            finished_at: null,
            exit_code: null,
            user_prompt: 'nightly job',
            prompt: null,
            context_meta: null,
          },
          {
            id: 'ignored',
            kind: 'release',
            status: 'done',
            session_id: 'sess-3',
            started_at: 400,
            finished_at: 420,
            exit_code: 0,
            user_prompt: 'should be ignored',
            prompt: null,
            context_meta: null,
          },
        ],
      }),
    }))

    let controls:
      | {
        loadSessions: () => Promise<void>
        restoreSession: (session: SessionItem) => Promise<void>
        getSessions: () => SessionItem[]
        isLoading: () => boolean
      }
      | undefined

    const { unmount } = renderElement(
      <SessionManagerHarness onReady={(value) => { controls = value }} />,
    )

    await vi.waitFor(() => {
      expect(controls).toBeTruthy()
    })

    if (!controls) throw new Error('manager not ready')
    await controls.loadSessions()

    await vi.waitFor(() => {
      expect(controls?.isLoading()).toBe(false)
      expect(controls?.getSessions()).toEqual([
        {
          id: 'job-newest',
          prompt: 'original prompt',
          startedAt: 300,
          finishedAt: 320,
          sessionId: 'sess-1',
          exitCode: 0,
        },
        {
          id: 'agent-job',
          prompt: 'nightly job',
          startedAt: 250,
          finishedAt: null,
          sessionId: 'sess-2',
          exitCode: null,
        },
      ])
    })

    unmount()
  })

  it('restores a running session with prior logs, context metadata, and live stream continuation', async () => {
    terminalStore.update('proj', () => ({
      claudeSessionId: 'different-session',
      history: [{ role: 'assistant', text: 'stale history' }],
    }))

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs?project=proj') {
        return {
          json: async () => ({
            jobs: [
              {
                id: 'run-1',
                kind: 'run',
                status: 'done',
                session_id: 'sess-restore',
                started_at: 100,
                finished_at: 120,
                exit_code: 0,
                user_prompt: 'first prompt',
                prompt: 'fallback first',
                context_meta: JSON.stringify({
                  skills: [{ id: 'skill-1', name: 'Checklist', description: 'desc', source: 'db' }],
                  docs: [{ name: 'Runbook', content: 'ops notes' }],
                }),
              },
              {
                id: 'run-2',
                kind: 'run',
                status: 'done',
                session_id: 'sess-restore',
                started_at: 150,
                finished_at: 180,
                exit_code: 0,
                user_prompt: 'second prompt',
                prompt: 'fallback second',
                context_meta: null,
              },
              {
                id: 'run-3',
                kind: 'run',
                status: 'running',
                session_id: 'sess-restore',
                started_at: 200,
                finished_at: null,
                exit_code: null,
                user_prompt: 'live prompt',
                prompt: 'fallback live',
                context_meta: null,
              },
            ],
          }),
        }
      }
      if (url === '/api/jobs/run-1') {
        return { json: async () => ({ log: 'assistant reply 1' }) }
      }
      if (url === '/api/jobs/run-2') {
        return { json: async () => ({ log: 'assistant reply 2' }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    let controls:
      | {
        loadSessions: () => Promise<void>
        restoreSession: (session: SessionItem) => Promise<void>
        getSessions: () => SessionItem[]
        isLoading: () => boolean
      }
      | undefined

    const { unmount } = renderElement(
      <SessionManagerHarness onReady={(value) => { controls = value }} />,
    )

    await vi.waitFor(() => {
      expect(controls).toBeTruthy()
    })

    if (!controls) throw new Error('manager not ready')
    await controls.restoreSession({
      id: 'run-3',
      prompt: 'live prompt',
      startedAt: 200,
      finishedAt: null,
      sessionId: 'sess-restore',
      exitCode: null,
    })

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/project/proj/terminal/sess-restore')
      expect(startStreamMock).toHaveBeenCalledWith('proj', 'run-3')
    })

    const state = terminalStore.get('proj')
    expect(state.claudeSessionId).toBe('sess-restore')
    expect(state.sessionKey).toBe('sess-restore')
    expect(state.restoredFor).toBe('sess-restore')
    expect(state.selectedItems).toEqual([{ id: 'skill-1', name: 'Checklist', description: 'desc', source: 'db' }])
    expect(state.selectedDocs).toEqual([{ name: 'Runbook', content: 'ops notes' }])
    expect(state.history).toEqual<TermEntry[]>([
      { role: 'user', text: 'first prompt' },
      { role: 'assistant', text: 'assistant reply 1' },
      { role: 'user', text: 'second prompt' },
      { role: 'assistant', text: 'assistant reply 2' },
      { role: 'user', text: 'live prompt' },
    ])

    unmount()
  })
})
