/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RunRow } from '@/components/project-runs/RunRow'
import type { Entry } from '@/components/project-runs/utils'

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
}))

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    key: 'job:1',
    kind: 'review',
    bucket: 'review',
    title: 'Code review',
    subtitle: 'Inspect recent changes',
    startedAt: 100,
    lastActivityAt: 110,
    finishedAt: 160,
    status: 'done',
    exitCode: 0,
    durationMs: 60_000,
    inputTokens: 1200,
    outputTokens: 3400,
    cacheReadTokens: 0,
    costUsd: 0.0123,
    turns: 1,
    model: 'sonnet',
    navJobId: 'job-1',
    navSessionId: 'session-12345678',
    failureLabel: null,
    releaseOutcome: null,
    logPruned: false,
    workSummary: null,
    modifiedFiles: null,
    children: [],
    chainedChildren: [],
    parentJobId: null,
    parentLabel: null,
    _jobIds: ['job-1'],
    ...overrides,
  }
}

function renderRow(props: React.ComponentProps<typeof RunRow>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(RunRow, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('RunRow', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders agent summaries and modified file counts', () => {
    const entry = makeEntry({
      kind: 'agent:tests',
      bucket: 'agent',
      title: 'tests',
      workSummary: 'Added focused API coverage.',
      modifiedFiles: JSON.stringify([{ path: 'a.ts' }, { path: 'b.ts' }]),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      subtitle: null,
      navSessionId: null,
      model: null,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Added focused API coverage.')
    expect(container.textContent).toContain('2 files')
    expect(container.textContent).toContain('agent')
    unmount()
  })

  it('shows failure labels and keeps expand toggles from triggering row clicks', () => {
    const onClick = vi.fn()
    const onToggleExpand = vi.fn()
    const entry = makeEntry({
      exitCode: 143,
      failureLabel: 'terminated',
    })

    const { container, unmount } = renderRow({
      entry,
      onClick,
      expandable: true,
      expanded: false,
      onToggleExpand,
    })

    expect(container.textContent).toContain('terminated')

    const buttons = container.querySelectorAll('button')
    const toggle = buttons[0]
    const row = container.querySelector('[role="button"]')
    if (!(toggle instanceof HTMLButtonElement) || !(row instanceof HTMLDivElement)) {
      throw new Error('expected row controls to render')
    }

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onToggleExpand).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('renders NEEDS ATTENTION reviews as attention instead of green done', () => {
    const entry = makeEntry({
      verdict: 'NEEDS ATTENTION',
      exitCode: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('review needs attention')
    expect(container.textContent).toContain('⚠ ATTN')
    expect(container.textContent).not.toContain('done')
    unmount()
  })

  it('renders DO NOT SHIP reviews as attention instead of green done', () => {
    const entry = makeEntry({
      verdict: 'DO NOT SHIP',
      exitCode: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('do not ship')
    expect(container.textContent).toContain('✗ DNS')
    expect(container.textContent).not.toContain('done')
    unmount()
  })

  it('hides parent badges for nested rows and renders release-attention state', () => {
    const nested = makeEntry({
      verdict: 'NEEDS ATTENTION',
      parentLabel: 'agent release-bot',
    })

    const { container: nestedContainer, unmount: unmountNested } = renderRow({
      entry: nested,
      onClick: vi.fn(),
      depth: 1,
    })

    expect(nestedContainer.textContent).toContain('⚠ ATTN')
    expect(nestedContainer.textContent).not.toContain('agent release-bot')
    unmountNested()

    const blockedRelease = makeEntry({
      kind: 'release',
      bucket: 'release',
      title: 'Release pipeline',
      subtitle: null,
      releaseOutcome: {
        status: 'blocked',
        label: 'release blocked',
        releaseJobId: 'rel-1',
        blockingJobId: 'review-1',
      },
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      navSessionId: null,
      model: null,
    })

    const { container: releaseContainer, unmount: unmountRelease } = renderRow({
      entry: blockedRelease,
      onClick: vi.fn(),
    })

    expect(releaseContainer.textContent).toContain('release blocked')
    unmountRelease()
  })
})
