/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TerminalMessages } from '@/components/terminal/TerminalMessages'
import {
  buildEntriesForCompletedJobs,
  retrievedContextEntryFromMeta,
  retrievedContextSourcesFromMeta,
  type RestorableJob,
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

describe('terminal completed job restore helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('restores successful completed logs without adding a synthetic exit status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        exit_code: 0,
        log: 'assistant reply',
        log_pruned: false,
      }),
    }))

    const jobs: RestorableJob[] = [{
      id: 'successful-job',
      kind: 'run',
      status: 'done',
      session_id: 'sess-ok',
      started_at: 100,
      finished_at: 120,
      exit_code: 0,
      user_prompt: 'run successful task',
      prompt: null,
      context_meta: null,
    }]

    await expect(buildEntriesForCompletedJobs(jobs)).resolves.toEqual([
      { role: 'user', text: 'run successful task' },
      { role: 'assistant', text: 'assistant reply' },
    ])
  })

  it('does not duplicate detail text already present in a failed plain-text log', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        exit_code: 1,
        log: 'fatal: auth expired',
        detail: 'fatal: auth expired',
      }),
    }))

    const jobs: RestorableJob[] = [{
      id: 'failed-job',
      kind: 'run',
      status: 'done',
      session_id: 'sess-failed',
      started_at: 100,
      finished_at: 120,
      exit_code: 1,
      user_prompt: 'run failed task',
      prompt: null,
      context_meta: null,
    }]

    await expect(buildEntriesForCompletedJobs(jobs)).resolves.toEqual([
      { role: 'user', text: 'run failed task' },
      { role: 'error', text: 'provider run failed' },
      { role: 'error', text: 'fatal: auth expired' },
    ])
  })

  it('restores missing-log detail once when no log output is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        exit_code: 1,
        log: '',
        detail: 'log file missing',
      }),
    }))

    const jobs: RestorableJob[] = [{
      id: 'missing-log-job',
      kind: 'run',
      status: 'done',
      session_id: 'sess-missing',
      started_at: 100,
      finished_at: 120,
      exit_code: 1,
      user_prompt: 'run missing log task',
      prompt: null,
      context_meta: null,
    }]

    await expect(buildEntriesForCompletedJobs(jobs)).resolves.toEqual([
      { role: 'user', text: 'run missing log task' },
      { role: 'error', text: 'exit 1' },
      { role: 'error', text: 'log file missing' },
    ])
  })

  it('restores mixed JSON log failure detail once when parsed output omits raw lines', async () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}}'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        exit_code: 1,
        log: `${line}\nfatal: auth expired\n`,
        detail: 'fatal: auth expired',
      }),
    }))

    const jobs: RestorableJob[] = [{
      id: 'mixed-log-job',
      kind: 'run',
      status: 'done',
      session_id: 'sess-mixed',
      started_at: 100,
      finished_at: 120,
      exit_code: 1,
      user_prompt: 'run mixed log task',
      prompt: null,
      context_meta: null,
    }]

    await expect(buildEntriesForCompletedJobs(jobs)).resolves.toEqual([
      { role: 'user', text: 'run mixed log task' },
      { role: 'error', text: 'provider run failed' },
      { role: 'assistant', text: 'partial answer' },
      { role: 'error', text: 'fatal: auth expired' },
    ])
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
