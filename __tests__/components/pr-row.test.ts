/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PRRow } from '@/components/issues-tab/PRRow'
import type { GhPullRequest } from '@/lib/client-api'

const { push, runMarkDod, reviewPR, approvePR, mergePR } = vi.hoisted(() => ({
  push: vi.fn(),
  runMarkDod: vi.fn(),
  reviewPR: vi.fn(),
  approvePR: vi.fn(),
  mergePR: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/lib/client-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-api')>('@/lib/client-api')
  return {
    ...actual,
    runMarkDod,
    reviewPR,
    approvePR,
    mergePR,
  }
})

function buildPr(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    number: 77,
    title: 'Improve release gating',
    state: 'OPEN',
    author: { login: 'octocat' },
    url: 'https://github.com/acme/widgets/pull/77',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
    headRefName: 'fix/issue-77-gates',
    baseRefName: 'master',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    labels: [{ name: 'release', color: 'ff6600' }],
    body: 'Fixes #77',
    statusCheckRollup: [
      {
        name: 'unit',
        workflowName: 'CI',
        conclusion: 'SUCCESS',
        status: 'COMPLETED',
        detailsUrl: 'https://ci.example/unit',
      },
      {
        name: 'lint',
        workflowName: 'CI',
        conclusion: null,
        status: 'IN_PROGRESS',
        detailsUrl: 'https://ci.example/lint',
      },
    ],
    ...overrides,
  }
}

function renderPrRow(props: React.ComponentProps<typeof PRRow>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextProps: React.ComponentProps<typeof PRRow>) => {
    flushSync(() => {
      root.render(React.createElement(PRRow, nextProps))
    })
  }

  render(props)

  return {
    container,
    rerender: render,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('PRRow', () => {
  beforeEach(() => {
    push.mockReset()
    runMarkDod.mockReset()
    reviewPR.mockReset()
    approvePR.mockReset()
    mergePR.mockReset()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('loads gate badges and runs DoD against the linked issue when one is present', async () => {
    // Gates are now folded into the PR payload (no per-row pr-gates fetch).
    vi.stubGlobal('fetch', vi.fn())
    runMarkDod.mockResolvedValue({ jobId: 'job-123' })

    const { container, unmount } = renderPrRow({
      pr: buildPr({ gates: { issueNumber: 77, tests: 'pass', review: 'warn', dod: 'warn', dodSummary: '2/3' } }),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    await vi.waitFor(() => expect(container.textContent).toContain('2/3'))
    const dodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('2/3'))
    dodButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(runMarkDod).toHaveBeenCalledWith('acme/widgets', { issue_number: 77, repo: 'acme/widgets' }),
    )
    expect(push).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal?job=job-123')
    unmount()
  })

  it('falls back to pr_number when DoD has no linked issue context', async () => {
    vi.stubGlobal('fetch', vi.fn())
    runMarkDod.mockResolvedValue({ jobId: 'job-456' })

    const { container, unmount } = renderPrRow({
      pr: buildPr({ gates: { issueNumber: null, tests: 'pass', review: 'pass', dod: 'warn', dodSummary: '1/1' } }),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    await vi.waitFor(() => expect(container.textContent).toContain('1/1'))
    const dodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('1/1'))
    dodButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(runMarkDod).toHaveBeenCalledWith('acme/widgets', { pr_number: 77, repo: 'acme/widgets' }),
    )
    unmount()
  })

  it('switches to the PR branch, stashes the prompt, and expands CI checks in place', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issueNumber: null,
          tests: 'pass',
          review: 'warn',
          dod: 'none',
          dodSummary: null,
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderPrRow({
      pr: buildPr(),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    const checksButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('1/2 checks'))
    checksButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(container.textContent).toContain('in_progress'))
    expect(container.textContent).toContain('CI')

    const terminalButton = container.querySelector('button[aria-label="Open in Terminal"]')
    terminalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/acme%2Fwidgets/pr-branch', expect.objectContaining({
        method: 'POST',
      })),
    )
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    const pendingUrl = push.mock.calls[0][0] as string
    expect(pendingUrl).toMatch(/^\/project\/acme%2Fwidgets\/terminal\?pending=/)
    const payload = JSON.parse(sessionStorage.getItem(pendingUrl.split('pending=')[1]) ?? '{}')
    expect(payload.prompt).toContain('Review pull request #77')
    expect(payload.prompt).toContain('fix/issue-77-gates → master')
    unmount()
  })

  it('keeps the fourth PR label visible before collapsing into overflow', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const { container, unmount } = renderPrRow({
      pr: buildPr({
        labels: [
          { name: 'release', color: 'ff6600' },
          { name: 'security', color: 'ff0000' },
          { name: 'backend', color: '0000ff' },
          { name: 'customer', color: '00aa88' },
          { name: 'needs-docs', color: 'aa00aa' },
        ],
      }),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    expect(container.textContent).toContain('release')
    expect(container.textContent).toContain('security')
    expect(container.textContent).toContain('backend')
    expect(container.textContent).toContain('customer')
    expect(container.textContent).not.toContain('needs-docs')
    expect(container.querySelector('[title="needs-docs"]')?.textContent).toBe('+1')
    unmount()
  })

  it('disables PR review while jobs are paused and re-enables it live', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const { container, rerender, unmount } = renderPrRow({
      pr: buildPr(),
      projectName: 'acme/widgets',
      jobsPaused: true,
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    const reviewButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Review')
    expect(reviewButton).toBeInstanceOf(HTMLButtonElement)
    expect((reviewButton as HTMLButtonElement).disabled).toBe(true)
    expect(reviewButton?.getAttribute('title')).toContain('Jobs are paused globally')

    rerender({
      pr: buildPr(),
      projectName: 'acme/widgets',
      jobsPaused: false,
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    await vi.waitFor(() => {
      const enabledReviewButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Review') as HTMLButtonElement | undefined
      expect(enabledReviewButton?.disabled).toBe(false)
      expect(enabledReviewButton?.getAttribute('title')).toBe('AI code review of this PR\'s diff')
    })

    unmount()
  })

  it('disables DoD verification while jobs are paused and re-enables it live', async () => {
    vi.stubGlobal('fetch', vi.fn())
    runMarkDod.mockResolvedValue({ jobId: 'job-789' })
    const gates = { issueNumber: 77, tests: 'pass' as const, review: 'warn' as const, dod: 'warn' as const, dodSummary: '2/3' }

    const { container, rerender, unmount } = renderPrRow({
      pr: buildPr({ gates }),
      projectName: 'acme/widgets',
      jobsPaused: true,
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    await vi.waitFor(() => expect(container.textContent).toContain('2/3'))
    const pausedDodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('2/3'))
    expect(pausedDodButton).toBeInstanceOf(HTMLButtonElement)
    expect((pausedDodButton as HTMLButtonElement).disabled).toBe(true)
    expect(pausedDodButton?.getAttribute('title')).toContain('Jobs are paused globally')
    pausedDodButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(runMarkDod).not.toHaveBeenCalled()

    rerender({
      pr: buildPr({ gates }),
      projectName: 'acme/widgets',
      jobsPaused: false,
      onMerged: vi.fn(),
      onOpen: () => {},
    })

    await vi.waitFor(() => {
      const enabledDodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('2/3')) as HTMLButtonElement | undefined
      expect(enabledDodButton?.disabled).toBe(false)
      expect(enabledDodButton?.getAttribute('title')).toContain('Click to verify acceptance criteria')
    })

    const enabledDodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('2/3'))
    enabledDodButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() =>
      expect(runMarkDod).toHaveBeenCalledWith('acme/widgets', { issue_number: 77, repo: 'acme/widgets' }),
    )

    unmount()
  })
})
