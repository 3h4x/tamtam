/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TerminalMessages } from '@/components/terminal/TerminalMessages'
import {
  retrievedContextEntryFromMeta,
  retrievedContextSourcesFromMeta,
} from '@/components/terminal/session-restore'
import type { TermEntry } from '@/lib/terminal/terminal-session-store'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('terminal retrieval context restore helpers', () => {
  it('returns no sources when context metadata has no retrieval source list', () => {
    expect(retrievedContextSourcesFromMeta(JSON.stringify({ retrieval: { acceptedCount: 0 } }))).toEqual([])
    expect(retrievedContextEntryFromMeta(JSON.stringify({ docs: [] }))).toBeNull()
  })

  it('builds a compact Retrieved Context status entry when source metadata exists', () => {
    const entry = retrievedContextEntryFromMeta(JSON.stringify({
      retrieval: {
        sources: [
          {
            sourceKind: 'project_doc',
            sourceId: 'docs/AGENT.md',
            project: 'tamtam',
            score: 0.93,
            rank: 1,
            preview: 'Agent intake stores context metadata.',
          },
        ],
      },
    }))

    expect(entry).toEqual({
      role: 'status',
      text: 'Retrieved Context\n1. project_doc docs/AGENT.md (tamtam score 0.93) - Agent intake stores context metadata.',
    })
  })
})

function renderTerminalMessages(history: TermEntry[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(React.createElement(TerminalMessages, {
      history,
      streaming: false,
      streamBuffer: '',
      thinkingBuffer: '',
      rawBuffer: '',
      streamTools: [],
      streamIsRaw: false,
      showThinking: false,
      messageQueue: [],
      pendingImageUrls: [],
      pendingImages: [],
      elapsedMs: 0,
      idleSec: 0,
      spinnerFrame: 0,
      runMeta: null,
      autoScroll: true,
      allItems: [],
      onScroll: () => {},
      onScrollToBottom: () => {},
      onToggleItem: () => {},
      onRemoveImage: () => {},
      onClearImages: () => {},
      onClearQueueItem: () => {},
      onCancel: () => {},
      termRef: React.createRef<HTMLDivElement>(),
      lastError: null,
      onResume: () => {},
      onDismissError: () => {},
    }))
  })
  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('TerminalMessages retrieved context section', () => {
  it('renders the Retrieved Context section only when metadata produces an entry', () => {
    const missingEntry = retrievedContextEntryFromMeta(JSON.stringify({ retrieval: { acceptedCount: 0 } }))
    const presentEntry = retrievedContextEntryFromMeta(JSON.stringify({
      retrieval: {
        sources: [{
          sourceKind: 'skill',
          sourceId: 'release-readiness',
          project: 'tamtam',
          score: 0.88,
          rank: 1,
          preview: 'Use release pipeline guardrails.',
        }],
      },
    }))

    const without = renderTerminalMessages(missingEntry ? [missingEntry] : [])
    expect(without.container.textContent).not.toContain('Retrieved Context')
    without.unmount()

    const withSection = renderTerminalMessages(presentEntry ? [presentEntry] : [])
    expect(withSection.container.textContent).toContain('Retrieved Context')
    expect(withSection.container.textContent).toContain('release-readiness')
    withSection.unmount()
  })
})
