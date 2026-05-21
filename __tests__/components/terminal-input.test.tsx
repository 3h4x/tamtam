/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TerminalInput } from '@/components/terminal/TerminalInput'

function renderTerminalInput(
  overrides: Partial<React.ComponentProps<typeof TerminalInput>> = {},
) {
  const onInputChange = vi.fn()
  const onHistoryIdxChange = vi.fn()
  const onSaveDraftBeforeHistory = vi.fn()
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const onClearQueue = vi.fn()
  const onPaste = vi.fn()
  const inputRef = React.createRef<HTMLTextAreaElement>()

  const props: React.ComponentProps<typeof TerminalInput> = {
    input: 'draft',
    streaming: false,
    claudeSessionId: null,
    currentJobId: null,
    lastStats: null,
    messageQueue: [],
    promptHistory: ['latest prompt', 'older prompt'],
    historyIdx: null,
    draftBeforeHistory: 'saved draft',
    inputRef,
    onInputChange,
    onHistoryIdxChange,
    onSaveDraftBeforeHistory,
    onSubmit,
    onCancel,
    onClearQueue,
    onPaste,
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(TerminalInput, props))
  })

  const textarea = container.querySelector('textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea not found')

  return {
    container,
    textarea,
    inputRef,
    onInputChange,
    onHistoryIdxChange,
    onSaveDraftBeforeHistory,
    onSubmit,
    onCancel,
    onClearQueue,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('TerminalInput', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('submits on Enter, clears on Escape, and cancels an active stream', () => {
    const enterCase = renderTerminalInput()
    enterCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(enterCase.onSubmit).toHaveBeenCalledTimes(1)
    enterCase.unmount()

    const clearCase = renderTerminalInput({ input: 'keep me' })
    clearCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(clearCase.onInputChange).toHaveBeenCalledWith('')
    clearCase.unmount()

    const cancelCase = renderTerminalInput({ streaming: true, input: 'queued' })
    cancelCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancelCase.onCancel).toHaveBeenCalledTimes(1)
    cancelCase.unmount()
  })

  it('walks prompt history only from the textarea edges and restores the saved draft', () => {
    const firstLineCase = renderTerminalInput({ input: 'draft', historyIdx: null })
    firstLineCase.textarea.setSelectionRange(firstLineCase.textarea.value.length, firstLineCase.textarea.value.length)
    firstLineCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))

    expect(firstLineCase.onSaveDraftBeforeHistory).toHaveBeenCalledWith('draft')
    expect(firstLineCase.onHistoryIdxChange).toHaveBeenCalledWith(0)
    expect(firstLineCase.onInputChange).toHaveBeenCalledWith('latest prompt')
    firstLineCase.unmount()

    const multiLineCase = renderTerminalInput({ input: 'first\nsecond', historyIdx: null })
    multiLineCase.textarea.setSelectionRange(multiLineCase.textarea.value.length, multiLineCase.textarea.value.length)
    multiLineCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(multiLineCase.onHistoryIdxChange).not.toHaveBeenCalled()
    multiLineCase.unmount()

    const restoreCase = renderTerminalInput({
      input: 'latest prompt',
      historyIdx: 0,
      draftBeforeHistory: 'draft restored',
    })
    restoreCase.textarea.setSelectionRange(restoreCase.textarea.value.length, restoreCase.textarea.value.length)
    restoreCase.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    expect(restoreCase.onHistoryIdxChange).toHaveBeenCalledWith(null)
    expect(restoreCase.onInputChange).toHaveBeenCalledWith('draft restored')
    restoreCase.unmount()
  })

  it('shows labeled session, status, and last-run metadata in the footer', () => {
    const { container, unmount } = renderTerminalInput({
      claudeSessionId: 'abc12345-aaaa-bbbb-cccc-ddddeeeeffff',
      currentJobId: 'job-1',
      streaming: true,
      lastStats: {
        duration: 1234,            // 1.2s
        inputTokens: 1500,         // 1.5k
        outputTokens: 250,         // 250
        cacheReadTokens: 8500,     // 8.5k
        cacheCreateTokens: 0,
      },
    })

    expect(container.textContent).toContain('session')
    expect(container.textContent).toContain('abc12345…')
    expect(container.textContent).toContain('status')
    expect(container.textContent).toContain('streaming')
    expect(container.textContent).toContain('last run')
    expect(container.textContent).toContain('1.2s')
    expect(container.textContent).toContain('tokens')
    expect(container.textContent).toContain('in 1.5k')
    expect(container.textContent).toContain('out 250')
    expect(container.textContent).toContain('cache')
    expect(container.textContent).toContain('8.5k read')
    expect(container.textContent).not.toContain('write')

    unmount()
  })

  it('formats large token counts and spells out cache read and write totals', () => {
    const { container, unmount } = renderTerminalInput({
      claudeSessionId: 'sess',
      lastStats: {
        duration: 10_000,
        inputTokens: 2_500_000, // 2.5M
        outputTokens: 999,      // raw (no formatting)
        cacheReadTokens: 5_000,
        cacheCreateTokens: 2_000,
      },
    })

    expect(container.textContent).toContain('in 2.5M')
    expect(container.textContent).toContain('out 999')
    expect(container.textContent).toContain('5.0k read')
    expect(container.textContent).toContain('/ 2.0k write')

    unmount()
  })

  it('explains that a new session starts on send when no session exists', () => {
    const { container, unmount } = renderTerminalInput({
      claudeSessionId: null,
      lastStats: null,
    })

    expect(container.textContent).toContain('session')
    expect(container.textContent).toContain('starts on send')
    expect(container.textContent).not.toContain('last run')
    expect(container.textContent).not.toContain('tokens')

    unmount()
  })

  it('shows the queued-message indicator and clears the queue on click', () => {
    const { container, onClearQueue, unmount } = renderTerminalInput({
      messageQueue: ['m1', 'm2', 'm3'],
    })

    expect(container.textContent).toContain('3 queued')
    const clearBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '✕')
    expect(clearBtn).toBeTruthy()
    expect(clearBtn?.getAttribute('aria-label')).toBe('Clear queued messages')
    clearBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClearQueue).toHaveBeenCalledTimes(1)

    unmount()
  })
})
