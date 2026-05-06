/* @vitest-environment jsdom */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TerminalMessages } from '@/components/terminal/TerminalMessages'
import type { SkillItem, TermEntry, ToolEntry } from '@/lib/terminal/terminal-session-store'

function renderTerminalMessagesMarkup({
  history = [],
  streaming = false,
  streamBuffer = '',
  thinkingBuffer = '',
  rawBuffer = '',
  streamTools = [],
  streamIsRaw = false,
}: {
  history?: TermEntry[]
  streaming?: boolean
  streamBuffer?: string
  thinkingBuffer?: string
  rawBuffer?: string
  streamTools?: ToolEntry[]
  streamIsRaw?: boolean
} = {}) {
  const noop = () => {}
  const allItems: SkillItem[] = []

  return renderToStaticMarkup(React.createElement(TerminalMessages, {
    history,
    streaming,
    streamBuffer,
    thinkingBuffer,
    rawBuffer,
    streamTools,
    streamIsRaw,
    showThinking: true,
    messageQueue: [],
    pendingImageUrls: [],
    pendingImages: [],
    elapsedMs: 0,
    idleSec: 0,
    spinnerFrame: 0,
    autoScroll: true,
    allItems,
    onScroll: noop,
    onScrollToBottom: noop,
    onToggleItem: noop,
    onRemoveImage: noop,
    onClearImages: noop,
    onClearQueueItem: noop,
    onCancel: noop,
    termRef: { current: null },
  }))
}

describe('TerminalMessages', () => {
  it('renders status and error lines with structured tone badges', () => {
    const markup = renderTerminalMessagesMarkup({
      history: [
        { role: 'status', text: 'Starting build\nexit 0 — ok' },
        { role: 'error', text: 'failed to push' },
      ],
    })

    expect(markup).toContain('Starting build')
    expect(markup).toContain('exit 0 — ok')
    expect(markup).toContain('failed to push')
    expect(markup).toContain('>status<')
    expect(markup).toContain('>info<')
    expect(markup).toContain('>ok<')
    expect(markup).toContain('>✗ error<')
  })

  it('collapses carriage-return progress updates for stored raw output', () => {
    const markup = renderTerminalMessagesMarkup({
      history: [
        { role: 'raw', text: 'Downloading 1%\rDownloading 100%\nDone' },
      ],
    })

    expect(markup).toContain('Downloading 100%')
    expect(markup).toContain('Done')
    expect(markup).not.toContain('Downloading 1%')
  })

  it('renders live raw streaming output with the raw badge and collapsed lines', () => {
    const markup = renderTerminalMessagesMarkup({
      streaming: true,
      rawBuffer: 'Step 1\rStep 2\nFinal line',
      streamBuffer: 'shell output',
      streamIsRaw: true,
    })

    expect(markup).toContain('>raw<')
    expect(markup).toContain('Step 2')
    expect(markup).toContain('Final line')
    expect(markup).not.toContain('Step 1')
    expect(markup).toContain('shell output')
  })
})
