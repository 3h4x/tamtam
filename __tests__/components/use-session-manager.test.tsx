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
      if (url.startsWith('/api/jobs?project=proj')) {
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
                context_meta: JSON.stringify({
                  prerequisite: {
                    command: 'printf marker',
                    exitCode: 0,
                    durationMs: 12,
                    artifactPath: '/tmp/run-3.prereq.txt',
                  },
                }),
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
      expect(startStreamMock).toHaveBeenCalledWith('proj', 'run-3', false, true)
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

  it('hydrates preview prompts before restoring terminal history', async () => {
    const fullCompletedPrompt = `completed ${'p'.repeat(260)}`
    const fullRunningPrompt = `running ${'q'.repeat(260)}`
    const completedPreview = `${fullCompletedPrompt.slice(0, 199)}…`
    const runningPreview = `${fullRunningPrompt.slice(0, 199)}…`

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/jobs?project=proj')) {
        return {
          json: async () => ({
            jobs: [
              {
                id: 'long-done',
                kind: 'run',
                status: 'done',
                session_id: 'sess-long',
                started_at: 100,
                finished_at: 120,
                exit_code: 0,
                user_prompt: completedPreview,
                prompt: null,
                context_meta: null,
              },
              {
                id: 'long-live',
                kind: 'run',
                status: 'running',
                session_id: 'sess-long',
                started_at: 200,
                finished_at: null,
                exit_code: null,
                user_prompt: runningPreview,
                prompt: null,
                context_meta: null,
              },
            ],
          }),
        }
      }
      if (url === '/api/jobs/long-done') {
        return {
          json: async () => ({
            user_prompt: fullCompletedPrompt,
            prompt: null,
            log: 'assistant reply',
            log_pruned: false,
          }),
        }
      }
      if (url === '/api/jobs/long-live') {
        return {
          json: async () => ({
            user_prompt: fullRunningPrompt,
            prompt: null,
            log_pruned: false,
          }),
        }
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
      id: 'long-live',
      prompt: runningPreview,
      startedAt: 200,
      finishedAt: null,
      sessionId: 'sess-long',
      exitCode: null,
    })

    await vi.waitFor(() => {
      expect(startStreamMock).toHaveBeenCalledWith('proj', 'long-live', false, false)
    })

    expect(terminalStore.get('proj').history).toEqual<TermEntry[]>([
      { role: 'user', text: fullCompletedPrompt },
      { role: 'assistant', text: 'assistant reply' },
      { role: 'user', text: fullRunningPrompt },
    ])

    unmount()
  })

  it('enables passthrough when restoring a still-running single job fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/still-running-1') {
        return {
          json: async () => ({
            session_id: null,
            context_meta: JSON.stringify({
              prerequisite: {
                command: 'printf marker',
                exitCode: 7,
                durationMs: 45,
                artifactPath: '/tmp/still-running-1.prereq.txt',
              },
            }),
          }),
        }
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
      id: 'still-running-1',
      prompt: 'keep streaming',
      startedAt: 200,
      finishedAt: null,
      sessionId: null,
      exitCode: null,
    })

    await vi.waitFor(() => {
      expect(startStreamMock).toHaveBeenCalledWith('proj', 'still-running-1', false, true)
    })

    const state = terminalStore.get('proj')
    expect(state.claudeSessionId).toBeNull()
    expect(state.sessionKey).toBe('new')
    expect(state.history).toEqual<TermEntry[]>([
      { role: 'user', text: 'keep streaming' },
    ])

    unmount()
  })

  it('restores a completed single job fallback with log output and context metadata', async () => {
    terminalStore.update('proj', () => ({
      claudeSessionId: 'old-session',
      history: [{ role: 'assistant', text: 'stale entry' }],
    }))

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/finished-1') {
        return {
          json: async () => ({
            log: 'saved assistant output',
            context_meta: JSON.stringify({
              skills: [{ id: 'skill-2', name: 'Docs', description: 'desc', source: 'file' }],
              docs: [{ name: 'Guide', content: 'updated steps' }],
            }),
          }),
        }
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
      id: 'finished-1',
      prompt: 'show saved output',
      startedAt: 300,
      finishedAt: 330,
      sessionId: 'sess-finished',
      exitCode: 0,
    })

    await vi.waitFor(() => {
      expect(startStreamMock).not.toHaveBeenCalled()
    })

    const state = terminalStore.get('proj')
    expect(state.claudeSessionId).toBe('sess-finished')
    expect(state.sessionKey).toBe('sess-finished')
    expect(state.selectedItems).toEqual([{ id: 'skill-2', name: 'Docs', description: 'desc', source: 'file' }])
    expect(state.selectedDocs).toEqual([{ name: 'Guide', content: 'updated steps' }])
    expect(state.history).toEqual<TermEntry[]>([
      { role: 'user', text: 'show saved output' },
      { role: 'assistant', text: 'saved assistant output' },
    ])

    unmount()
  })

  it('restores failed plain-text logs as error entries in the single-job fallback path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/failed-1') {
        return {
          json: async () => ({
            exit_code: 1,
            log: 'fatal: auth expired',
            context_meta: null,
            log_pruned: false,
          }),
        }
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
      id: 'failed-1',
      prompt: 'show failure',
      startedAt: 300,
      finishedAt: 330,
      sessionId: 'sess-failed',
      exitCode: 1,
    })

    const state = terminalStore.get('proj')
    expect(state.history).toEqual<TermEntry[]>([
      { role: 'user', text: 'show failure' },
      { role: 'error', text: 'claude run failed' },
      { role: 'error', text: 'fatal: auth expired' },
    ])

    unmount()
  })
})
