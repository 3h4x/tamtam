/* @vitest-environment jsdom */

import React, { useEffect, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useHandleSubmit } from '@/components/terminal/useHandleSubmit'
import { terminalStore } from '@/lib/terminal/terminal-session-store'

const { runProjectMock } = vi.hoisted(() => ({
  runProjectMock: vi.fn(),
}))

const startStreamMock = vi.spyOn(terminalStore, 'startStream').mockImplementation(() => {})

vi.mock('@/lib/client-api', () => ({
  runProject: runProjectMock,
}))

type SetInput = (v: string) => void
type SetPendingImages = Dispatch<SetStateAction<File[]>>
type SetPendingImageUrls = Dispatch<SetStateAction<string[]>>
type SetPromptHistory = Dispatch<SetStateAction<string[]>>
type SetHistoryIdx = Dispatch<SetStateAction<number | null>>
type SetMessageQueue = (v: string[] | ((prev: string[]) => string[])) => void

function SubmitHarness({
  onReady,
  overrides = {},
}: {
  onReady: (submit: (text?: string) => Promise<void>) => void
  overrides?: Partial<React.ComponentProps<typeof SubmitHarnessInner>>
}) {
  return <SubmitHarnessInner onReady={onReady} {...overrides} />
}

function SubmitHarnessInner({
  onReady,
  streaming = false,
  input = '',
  pendingImages = [],
  pendingImageUrls = [],
  selectedItems = [],
  selectedDocs = [],
  model = 'fast',
  issueContext = null,
  draftBeforeHistory = '',
  setInput = vi.fn<SetInput>(),
  setPendingImages = vi.fn<SetPendingImages>(),
  setPendingImageUrls = vi.fn<SetPendingImageUrls>(),
  setPromptHistory = vi.fn<SetPromptHistory>(),
  setHistoryIdx = vi.fn<SetHistoryIdx>(),
  setMessageQueue = vi.fn<SetMessageQueue>(),
}: {
  onReady: (submit: (text?: string) => Promise<void>) => void
  streaming?: boolean
  input?: string
  pendingImages?: File[]
  pendingImageUrls?: string[]
  selectedItems?: Array<{ id: string; name: string; description: string; content?: string; source: 'db' | 'file' }>
  selectedDocs?: Array<{ name: string; content: string }>
  model?: 'fast' | 'normal' | 'smart'
  issueContext?: { number: number; repo: string; title: string } | null
  draftBeforeHistory?: string
  setInput?: SetInput
  setPendingImages?: SetPendingImages
  setPendingImageUrls?: SetPendingImageUrls
  setPromptHistory?: SetPromptHistory
  setHistoryIdx?: SetHistoryIdx
  setMessageQueue?: SetMessageQueue
}) {
  const { handleSubmit } = useHandleSubmit({
    projectName: 'proj',
    streaming,
    input,
    pendingImages,
    pendingImageUrls,
    selectedItems,
    selectedDocs,
    model,
    issueContextRef: { current: issueContext },
    draftBeforeHistoryRef: { current: draftBeforeHistory },
    setInput,
    setPendingImages,
    setPendingImageUrls,
    setPromptHistory,
    setHistoryIdx,
    setMessageQueue,
  })

  useEffect(() => {
    onReady(handleSubmit)
  }, [handleSubmit, onReady])

  return null
}

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

describe('useHandleSubmit', () => {
  beforeEach(() => {
    runProjectMock.mockReset()
    startStreamMock.mockClear()
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    terminalStore.reset('proj')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    terminalStore.reset('proj')
    document.body.innerHTML = ''
  })

  it('queues text during streaming instead of starting a new run', async () => {
    const setInput = vi.fn<SetInput>()
    const setMessageQueue = vi.fn<SetMessageQueue>()

    let submit: ((text?: string) => Promise<void>) | undefined
    const { unmount } = renderElement(
      <SubmitHarness
        onReady={(handler) => { submit = handler }}
        overrides={{
          streaming: true,
          input: 'queued follow-up',
          setInput,
          setMessageQueue,
        }}
      />,
    )

    await vi.waitFor(() => {
      expect(submit).toBeTypeOf('function')
    })

    const submitFn = submit
    if (typeof submitFn !== 'function') throw new Error('submit handler not ready')
    await submitFn()

    expect(setMessageQueue).toHaveBeenCalledWith(expect.any(Function))
    const queueUpdater = setMessageQueue.mock.calls[0][0] as (prev: string[]) => string[]
    expect(queueUpdater(['first'])).toEqual(['first', 'queued follow-up'])
    expect(setInput).toHaveBeenCalledWith('')
    expect(runProjectMock).not.toHaveBeenCalled()

    unmount()
  })

  it('builds prompt context and restores inspectable job logs for a fresh terminal turn', async () => {
    terminalStore.update('proj', () => ({
      currentJobId: 'proj-review-123',
    }))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'prior review output' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    runProjectMock.mockResolvedValue({ status: 'started', job_id: 'job-123', pid: 999 })

    const setInput = vi.fn<SetInput>()
    const setPendingImages = vi.fn<SetPendingImages>()
    const setPendingImageUrls = vi.fn<SetPendingImageUrls>()
    const setPromptHistory = vi.fn<SetPromptHistory>()
    const setHistoryIdx = vi.fn<SetHistoryIdx>()

    let submit: ((text?: string) => Promise<void>) | undefined
    const { unmount } = renderElement(
      <SubmitHarness
        onReady={(handler) => { submit = handler }}
        overrides={{
          input: 'ship it',
          pendingImageUrls: ['https://img.example/shot.png'],
          selectedItems: [
            { id: 'persona:cto', name: 'CTO', description: 'persona', source: 'file' },
            { id: 'db:checklist', name: 'Checklist', description: 'db skill', content: 'Review carefully', source: 'db' },
          ],
          selectedDocs: [
            { name: 'Release notes', content: 'Document context' },
          ],
          issueContext: { number: 42, repo: 'acme/widgets', title: 'Fix regression' },
          setInput,
          setPendingImages,
          setPendingImageUrls,
          setPromptHistory,
          setHistoryIdx,
        }}
      />,
    )

    await vi.waitFor(() => {
      expect(submit).toBeTypeOf('function')
    })

    const submitFn = submit
    if (typeof submitFn !== 'function') throw new Error('submit handler not ready')
    await submitFn()

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/proj-review-123/logs')
    expect(runProjectMock).toHaveBeenCalledWith('proj', expect.stringContaining('## Release notes'), expect.objectContaining({
      personas: ['cto'],
      resumeSessionId: undefined,
      provider: undefined,
      userPrompt: 'ship it',
      ghIssueNumber: 42,
      ghIssueRepo: 'acme/widgets',
      ghIssueTitle: 'Fix regression',
    }))
    const fullPrompt = runProjectMock.mock.calls[0][1] as string
    expect(fullPrompt).toContain('## Previous session output (review job, for context)')
    expect(fullPrompt).toContain('prior review output')
    expect(fullPrompt).toContain('## Checklist')
    expect(fullPrompt).toContain('Review carefully')
    expect(fullPrompt).toContain('## Release notes')
    expect(fullPrompt).toContain('Document context')
    expect(fullPrompt).toContain('ship it')

    expect(setPromptHistory).toHaveBeenCalledWith(expect.any(Function))
    const promptUpdater = setPromptHistory.mock.calls[0][0] as (prev: string[]) => string[]
    expect(promptUpdater(['older', 'ship it'])).toEqual(['ship it', 'older'])
    expect(setHistoryIdx).toHaveBeenCalledWith(null)
    expect(setInput).toHaveBeenCalledWith('')
    expect(setPendingImages).toHaveBeenCalledWith([])
    expect(setPendingImageUrls).toHaveBeenCalledWith([])
    expect(startStreamMock).toHaveBeenCalledWith('proj', 'job-123')

    const state = terminalStore.get('proj')
    expect(state.history.at(-1)).toEqual({
      role: 'user',
      text: 'ship it',
      imageUrls: ['https://img.example/shot.png'],
    })

    unmount()
  })
})
