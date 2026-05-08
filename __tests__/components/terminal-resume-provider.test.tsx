/* @vitest-environment jsdom */

import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useTerminalBootstrap } from '@/components/terminal/useTerminalBootstrap'
import { useHandleSubmit } from '@/components/terminal/useHandleSubmit'
import { terminalStore } from '@/lib/terminal/terminal-session-store'

const { replaceMock, runProjectMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  runProjectMock: vi.fn(),
}))

const startStreamMock = vi.spyOn(terminalStore, 'startStream').mockImplementation(() => {})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  runProject: runProjectMock,
  fetchSkills: vi.fn().mockResolvedValue({ skills: [] }),
  fetchPersonas: vi.fn().mockResolvedValue({ personas: [] }),
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
      root.unmount()
      container.remove()
    },
  }
}

function BootstrapHarness() {
  useTerminalBootstrap({
    projectName: 'proj',
    initialSessionId: undefined,
    jobParam: null,
    promptParam: 'continue issue',
    issueNumberParam: null,
    issueTitleParam: null,
    resumeSessionIdParam: 'sess-codex-1',
    resumeProviderParam: 'codex',
    onLoadSessions: vi.fn(),
  })
  return null
}

function JobBootstrapHarness({ jobParam }: { jobParam: string }) {
  useTerminalBootstrap({
    projectName: 'proj',
    initialSessionId: undefined,
    jobParam,
    promptParam: null,
    issueNumberParam: null,
    issueTitleParam: null,
    resumeSessionIdParam: null,
    resumeProviderParam: null,
    onLoadSessions: vi.fn(),
  })
  return null
}

function SessionBootstrapHarness({ sessionId }: { sessionId: string }) {
  useTerminalBootstrap({
    projectName: 'proj',
    initialSessionId: sessionId,
    jobParam: null,
    promptParam: null,
    issueNumberParam: null,
    issueTitleParam: null,
    resumeSessionIdParam: null,
    resumeProviderParam: null,
    onLoadSessions: vi.fn(),
  })
  return null
}

function SubmitHarness({ onReady }: { onReady: (submit: (text?: string) => Promise<void>) => void }) {
  const { handleSubmit } = useHandleSubmit({
    projectName: 'proj',
    streaming: false,
    input: '',
    pendingImages: [],
    pendingImageUrls: [],
    selectedItems: [],
    selectedDocs: [],
    model: 'fast',
    issueContextRef: { current: null },
    draftBeforeHistoryRef: { current: '' },
    setInput: vi.fn(),
    setPendingImages: vi.fn(),
    setPendingImageUrls: vi.fn(),
    setPromptHistory: vi.fn(),
    setHistoryIdx: vi.fn(),
    setMessageQueue: vi.fn(),
  })

  useEffect(() => {
    onReady(handleSubmit)
  }, [handleSubmit, onReady])

  return null
}

describe('pending continue-issue resume provider', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    runProjectMock.mockReset()
    startStreamMock.mockClear()
    vi.stubGlobal('fetch', vi.fn())
    terminalStore.reset('proj')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    terminalStore.reset('proj')
    document.body.innerHTML = ''
  })

  it('hydrates sessionProvider from the pending resume payload', async () => {
    const { unmount } = renderElement(<BootstrapHarness />)

    await vi.waitFor(() => {
      const state = terminalStore.get('proj')
      expect(state.claudeSessionId).toBe('sess-codex-1')
      expect(state.sessionProvider).toBe('codex')
      expect(state.pendingAutoSubmit).toBe('continue issue')
    })

    unmount()
  })

  it('passes both resumeSessionId and provider when submitting a pending resume', async () => {
    terminalStore.update('proj', () => ({
      claudeSessionId: 'sess-codex-2',
      sessionProvider: 'codex',
    }))
    runProjectMock.mockResolvedValue({ status: 'started', job_id: 'job-123', pid: 999 })

    let submit: ((text?: string) => Promise<void>) | undefined
    const { unmount } = renderElement(<SubmitHarness onReady={(handler) => { submit = handler }} />)

    await vi.waitFor(() => {
      expect(submit).toBeTypeOf('function')
    })
    const submitFn = submit
    if (typeof submitFn !== 'function') throw new Error('submit handler not ready')
    await submitFn('resume this issue')

    expect(runProjectMock).toHaveBeenCalledWith('proj', 'resume this issue', expect.objectContaining({
      resumeSessionId: 'sess-codex-2',
      provider: 'codex',
    }))
    expect(startStreamMock).toHaveBeenCalledWith('proj', 'job-123')

    unmount()
  })

  it('aborts auto-submit when issue-branch checkout fails and records the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Conflict',
      json: async () => ({ detail: 'dirty worktree' }),
    }))

    function IssueBranchBootstrapHarness() {
      useTerminalBootstrap({
        projectName: 'proj',
        initialSessionId: undefined,
        jobParam: null,
        promptParam: 'continue issue',
        issueNumberParam: '7',
        issueTitleParam: 'Fix me',
        resumeSessionIdParam: null,
        resumeProviderParam: null,
        onLoadSessions: vi.fn(),
      })
      return null
    }

    const { unmount } = renderElement(<IssueBranchBootstrapHarness />)

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/project/proj/terminal')
      expect(terminalStore.get('proj').history.at(-1)?.text).toContain('Could not check out the issue branch: dirty worktree')
    })

    expect(terminalStore.get('proj').pendingAutoSubmit).toBeNull()
    unmount()
  })

  it('renders cancelled for pruned aborted jobs loaded via job param', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/release-1') {
        return {
          ok: true,
          json: async () => ({
            id: 'release-1',
            kind: 'release',
            release_id: 'rel-1',
            session_id: null,
            started_at: 1_700_000_000,
            exit_code: -3,
            user_prompt: null,
            prompt: null,
            context_meta: null,
            provider: null,
            log_pruned: true,
          }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const { unmount } = renderElement(<JobBootstrapHarness jobParam="release-1" />)

    await vi.waitFor(() => {
      const history = terminalStore.get('proj').history
      expect(history.some((entry) => entry.text === 'Log file deleted by retention policy')).toBe(true)
      expect(history.some((entry) => entry.text === 'cancelled')).toBe(true)
      expect(history.some((entry) => entry.text === 'exit -3')).toBe(false)
    })

    expect(startStreamMock).not.toHaveBeenCalled()
    unmount()
  })

  it('renders cancelled for restored sessions with retained cancelled logs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs?project=proj') {
        return {
          ok: true,
          json: async () => ({
            jobs: [{
              id: 'review-1',
              kind: 'review',
              status: 'done',
              session_id: 'sess-cancelled',
              started_at: 1_700_000_000,
              finished_at: 1_700_000_100,
              exit_code: -2,
              user_prompt: 'review this',
              prompt: null,
              context_meta: null,
              provider: 'claude',
            }],
          }),
        }
      }
      if (url === '/api/jobs/review-1') {
        return {
          ok: true,
          json: async () => ({
            id: 'review-1',
            exit_code: -2,
            log: 'partial assistant output',
            log_pruned: false,
          }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const { unmount } = renderElement(<SessionBootstrapHarness sessionId="sess-cancelled" />)

    await vi.waitFor(() => {
      const history = terminalStore.get('proj').history
      expect(history.some((entry) => entry.text === 'partial assistant output')).toBe(true)
      expect(history.some((entry) => entry.text === 'cancelled')).toBe(true)
      expect(history.some((entry) => entry.text === 'claude run failed')).toBe(false)
      expect(history.some((entry) => entry.text === 'exit -2')).toBe(false)
    })

    expect(startStreamMock).not.toHaveBeenCalled()
    unmount()
  })

  it('renders cancelled after job-param redirect to a cancelled session restore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/review-redirect') {
        return {
          ok: true,
          json: async () => ({
            id: 'review-redirect',
            kind: 'review',
            session_id: 'sess-redirect',
            started_at: 1_700_000_000,
            exit_code: -3,
            user_prompt: null,
            prompt: null,
            context_meta: null,
            provider: 'claude',
          }),
        }
      }
      if (url === '/api/jobs?project=proj') {
        return {
          ok: true,
          json: async () => ({
            jobs: [{
              id: 'review-redirect',
              kind: 'review',
              status: 'done',
              session_id: 'sess-redirect',
              started_at: 1_700_000_000,
              finished_at: 1_700_000_100,
              exit_code: -3,
              user_prompt: 'resume review',
              prompt: null,
              context_meta: null,
              provider: 'claude',
            }],
          }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const redirected = renderElement(<JobBootstrapHarness jobParam="review-redirect" />)

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/project/proj/terminal/sess-redirect')
    })

    redirected.unmount()

    const fetchMock = vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs?project=proj') {
        return {
          ok: true,
          json: async () => ({
            jobs: [{
              id: 'review-redirect',
              kind: 'review',
              status: 'done',
              session_id: 'sess-redirect',
              started_at: 1_700_000_000,
              finished_at: 1_700_000_100,
              exit_code: -3,
              user_prompt: 'resume review',
              prompt: null,
              context_meta: null,
              provider: 'claude',
            }],
          }),
        }
      }
      if (url === '/api/jobs/review-redirect') {
        return {
          ok: true,
          json: async () => ({
            id: 'review-redirect',
            exit_code: -3,
            log: 'review log before cancellation',
            log_pruned: false,
          }),
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    void fetchMock

    const restored = renderElement(<SessionBootstrapHarness sessionId="sess-redirect" />)

    await vi.waitFor(() => {
      const history = terminalStore.get('proj').history
      expect(history.some((entry) => entry.text === 'review log before cancellation')).toBe(true)
      expect(history.some((entry) => entry.text === 'cancelled')).toBe(true)
      expect(history.some((entry) => entry.text === 'claude run failed')).toBe(false)
      expect(history.some((entry) => entry.text === 'exit -3')).toBe(false)
    })

    expect(startStreamMock).not.toHaveBeenCalled()
    restored.unmount()
  })
})
