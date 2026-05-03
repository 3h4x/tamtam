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

  flushSync(() => {
    root.render(React.createElement(PRRow, props))
  })

  return {
    container,
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issueNumber: 77,
        tests: 'pass',
        review: 'warn',
        dod: 'warn',
        dodSummary: '2/3',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    runMarkDod.mockResolvedValue({ jobId: 'job-123' })

    const { container, unmount } = renderPrRow({
      pr: buildPr(),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
    })

    await vi.waitFor(() => expect(container.textContent).toContain('2/3'))
    const dodButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('2/3'))
    dodButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(runMarkDod).toHaveBeenCalledWith('acme/widgets', { issue_number: 77, repo: 'acme/widgets' }),
    )
    expect(push).toHaveBeenCalledWith('/project/acme/widgets/terminal?job=job-123')
    unmount()
  })

  it('falls back to pr_number when DoD has no linked issue context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issueNumber: null,
        tests: 'pass',
        review: 'pass',
        dod: 'warn',
        dodSummary: '1/1',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    runMarkDod.mockResolvedValue({ jobId: 'job-456' })

    const { container, unmount } = renderPrRow({
      pr: buildPr(),
      projectName: 'acme/widgets',
      onMerged: vi.fn(),
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
    })

    const checksButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('1/2 checks'))
    checksButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(container.textContent).toContain('in_progress'))
    expect(container.textContent).toContain('CI')

    const terminalButton = container.querySelector('button[aria-label="Open in Terminal"]')
    terminalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/acme/widgets/pr-branch', expect.objectContaining({
        method: 'POST',
      })),
    )
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    const pendingUrl = push.mock.calls[0][0] as string
    expect(pendingUrl).toMatch(/^\/project\/acme\/widgets\/terminal\?pending=/)
    const payload = JSON.parse(sessionStorage.getItem(pendingUrl.split('pending=')[1]) ?? '{}')
    expect(payload.prompt).toContain('Review pull request #77')
    expect(payload.prompt).toContain('fix/issue-77-gates → master')
    unmount()
  })
})
