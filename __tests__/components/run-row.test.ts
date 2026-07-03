/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RunRow } from '@/components/project-runs/RunRow'
import type { Entry } from '@/components/project-runs/types'

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
}))

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    key: 'job:1',
    project: 'acme/widgets',
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
    releaseId: null,
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

  it('surfaces the reason a failed owned release stopped, over the agent\'s own summary', () => {
    // Reported bug: "Continue release" from an agent row later flips to
    // "failed" with no cause. The row goes red because of the owned release,
    // so its stop reason must show — not the agent's own (success) work summary.
    const reason = 'review startup failed: Jobs are paused globally. Turn the switch back on in Settings to start a review.'
    const entry = makeEntry({
      kind: 'agent:issue-cruncher',
      bucket: 'agent',
      title: 'issue-cruncher',
      exitCode: 0,
      workSummary: 'Merged the follow-up PR and tidied the branch.',
      subtitle: null,
      navSessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      releaseOutcome: { status: 'failed', label: 'release failed', releaseJobId: 'rel-1', reason },
    })

    const { container, unmount } = renderRow({ entry, onClick: vi.fn() })

    expect(container.textContent).toContain('review startup failed')
    expect(container.textContent).toContain('Jobs are paused globally')
    expect(container.textContent?.toLowerCase()).toContain('reason')
    // The release failure reason wins over the agent's own work summary.
    expect(container.textContent).not.toContain('Merged the follow-up PR')
    unmount()
  })

  it('renders finished run summaries in the main row body', () => {
    const entry = makeEntry({
      bucket: 'run',
      kind: 'run',
      title: 'Ship the release fix',
      workSummary: 'Updated the pipeline view and stored a concise run report.',
      subtitle: 'Initial prompt',
      navSessionId: 'session-12345678',
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Updated the pipeline view and stored a concise run report.')
    unmount()
  })

  it('formats markdown-ish run summaries into readable multiline text', () => {
    const entry = makeEntry({
      bucket: 'agent',
      kind: 'agent:issue-cruncher',
      title: 'issue-cruncher',
      workSummary: '- **Summary:** Implemented issue `#32`.\n- **Files changed:** `src/lib/audit.ts`, `app/[site]/page.tsx`\n- **Actionable work:** yes',
      subtitle: null,
      navSessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Summary:')
    expect(container.textContent).toContain('Implemented issue #32.')
    expect(container.textContent).toContain('Files changed:')
    expect(container.textContent).toContain('src/lib/audit.ts')
    expect(container.textContent).toContain('Actionable work:')
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('`')
    expect(container.textContent).not.toContain('\n-')
    unmount()
  })

  it('preserves freeform prose summaries instead of turning punctuation into bullets', () => {
    const entry = makeEntry({
      bucket: 'run',
      kind: 'run',
      title: 'Ship the release fix',
      workSummary: 'Fix is in `src/foo.ts` - no further work needed.',
      subtitle: null,
      navSessionId: 'session-12345678',
      model: null,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Fix is in `src/foo.ts` - no further work needed.')
    expect(container.textContent).not.toContain('Fix is in `src/foo.ts`- no further work needed.')
    unmount()
  })

  it('preserves running prompt subtitles even when they start with report labels', () => {
    const entry = makeEntry({
      bucket: 'review',
      kind: 'review',
      status: 'running',
      finishedAt: null,
      exitCode: null,
      workSummary: null,
      subtitle: 'Summary: repro in `src/foo.ts` with user prompt context only.',
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Summary: repro in `src/foo.ts` with user prompt context only.')
    expect(container.textContent).not.toContain('Summary:repro in src/foo.ts with user prompt context only.')
    unmount()
  })

  it('renders active release progress without completed phase noise', () => {
    const entry = makeEntry({
      kind: 'release',
      bucket: 'release',
      title: 'Release pipeline',
      subtitle: null,
      status: 'running',
      finishedAt: null,
      exitCode: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      navSessionId: null,
      model: null,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
      progressLabel: 'now: review',
      summary: 'test ✓ · review …',
    })

    expect(container.textContent).toContain('now: review')
    expect(container.textContent).not.toContain('test ✓')
    expect(container.textContent).not.toContain('review …')
    unmount()
  })

  it('hides successful pipeline summary chips', () => {
    const entry = makeEntry({
      kind: 'release',
      bucket: 'release',
      title: 'Release pipeline',
      subtitle: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      navSessionId: null,
      model: null,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
      summary: 'test ✓ · fix ✓ · review LGTM · fix ✓',
    })

    expect(container.textContent).not.toContain('test ✓')
    expect(container.textContent).not.toContain('review LGTM')
    expect(container.textContent).not.toContain('fix ✓')
    unmount()
  })

  it('renders only the latest failed pipeline summary chip', () => {
    const entry = makeEntry({
      kind: 'release',
      bucket: 'release',
      title: 'Release pipeline',
      subtitle: null,
      exitCode: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      navSessionId: null,
      model: null,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
      summary: 'test ✓ · push ✗1',
    })

    const successChip = Array.from(container.querySelectorAll('span')).find((node) => node.textContent === 'test ✓')
    const failedChip = Array.from(container.querySelectorAll('span')).find((node) => node.textContent === 'push ✗1')
    expect(successChip).toBeUndefined()
    expect(failedChip?.className).toContain('text-status-error')
    unmount()
  })

  it('labels the metadata chip as started instead of live or last', () => {
    const entry = makeEntry({
      status: 'running',
      finishedAt: null,
      exitCode: null,
      startedAt: 123,
      lastActivityAt: 999,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('startedago:123')
    expect(container.textContent).not.toContain('live')
    expect(container.textContent).not.toContain('last')
    // "started" must appear exactly once (no duplicate label).
    expect(container.textContent!.split('started').length).toBe(2)
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

  it('renders stopped jobs with exit code -2 as cancelled', () => {
    const entry = makeEntry({
      exitCode: -2,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('cancelled')
    expect(container.textContent).not.toContain('exit -2')
    unmount()
  })

  it('does not duplicate the mark-dod category when the title already includes DoD detail', () => {
    const entry = makeEntry({
      kind: 'mark-dod',
      bucket: 'mark-dod',
      title: 'Mark DoD - 2/3 verified, 1 unverified',
      subtitle: null,
      navSessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Mark DoD - 2/3 verified, 1 unverified')
    expect(container.textContent?.match(/Mark DoD/g)).toHaveLength(1)
    unmount()
  })

  it('keeps the stable pipeline step name visible beside descriptive titles', () => {
    const entry = makeEntry({
      kind: 'test',
      bucket: 'test',
      title: 'Running tests...',
      subtitle: null,
      navSessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Test run')
    expect(container.textContent).toContain('Running tests...')
    unmount()
  })

  it('does not prefix synthetic pipeline-step release rows with Release pipeline', () => {
    const entry = makeEntry({
      kind: 'release',
      bucket: 'release',
      title: 'Pipeline steps',
      subtitle: null,
      navSessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    expect(container.textContent).toContain('Pipeline steps')
    expect(container.textContent).not.toContain('Release pipelinePipeline steps')
    expect(container.textContent).not.toContain('Release pipeline Pipeline steps')
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

  it('renders follow-up issue badges with the documented warning token', () => {
    const entry = makeEntry({
      followupIssueUrl: 'https://github.com/acme/widgets/issues/42',
      followupIssueNumber: 42,
    })

    const { container, unmount } = renderRow({
      entry,
      onClick: vi.fn(),
    })

    const badge = container.querySelector('a[href="https://github.com/acme/widgets/issues/42"]')
    const classes = Array.from(badge?.classList ?? [])
    expect(badge?.textContent).toContain('filed #42')
    expect(classes).toContain('border-status-warning/40')
    expect(classes).toContain('bg-status-warning/15')
    expect(classes).toContain('text-status-warning')
    expect(classes).not.toContain('border-status-warn/40')
    expect(classes).not.toContain('bg-status-warn/15')
    expect(classes).not.toContain('text-status-warn')
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
