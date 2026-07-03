/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { IssuesTab } from '@/components/IssuesTab'
import type { GhIssue, GhPullRequest, ProjectConfig } from '@/lib/client-api'

const { fetchAgents, fetchIssuesAndPRs, fetchProjectConfig, pushMock, runAgent, toastMock } = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchIssuesAndPRs: vi.fn(),
  fetchProjectConfig: vi.fn(),
  pushMock: vi.fn(),
  runAgent: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/project/acme/issues',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchAgents,
  fetchIssuesAndPRs,
  fetchProjectConfig,
  runAgent,
}))

vi.mock('@/components/issues-tab/PRRow', () => ({
  PRRow: ({ pr, jobsPaused }: { pr: GhPullRequest; jobsPaused?: boolean }) => React.createElement(
    'div',
    {
      'data-testid': `pr-${pr.number}`,
      'data-jobs-paused': jobsPaused ? 'true' : 'false',
    },
    pr.title,
  ),
}))

vi.mock('@/components/issues-tab/IssueRow', () => ({
  IssueRow: ({ issue, projectCfg }: { issue: GhIssue; projectCfg: ProjectConfig | null }) =>
    React.createElement(
      'div',
      {
        'data-testid': `issue-${issue.number}`,
        'data-config': projectCfg?.effective_test_command ?? 'none',
      },
      issue.title,
    ),
}))

function buildPullRequest(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    number: 7,
    title: 'Stabilize pipeline retry',
    state: 'OPEN',
    author: { login: 'octocat' },
    url: 'https://github.com/acme/widgets/pull/7',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-02T12:00:00Z',
    isDraft: false,
    labels: [],
    reviewDecision: null,
    body: 'Fixes #7',
    headRefName: 'fix/retry',
    baseRefName: 'master',
    statusCheckRollup: null,
    ...overrides,
  }
}

function buildIssue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 42,
    title: 'Handle clean-branch push path',
    state: 'OPEN',
    author: { login: 'octocat' },
    url: 'https://github.com/acme/widgets/issues/42',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-02T12:00:00Z',
    labels: [],
    assignees: [],
    body: 'body',
    ...overrides,
  }
}

function buildConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: 'acme/widgets',
    test_command: 'pnpm test',
    detected_test_command: 'pnpm test',
    effective_test_command: 'pnpm test',
    test_cron_enabled: false,
    test_cron_schedule: '0 * * * *',
    auto_commit_enabled: true,
    auto_push_enabled: false,
    auto_pr_merge_enabled: false,
    release_after_run: false,
    issue_auto_branch: true,
    tests_disabled: false,
    review_disabled: false,
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  }
}

function renderIssuesTab(props: React.ComponentProps<typeof IssuesTab>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextProps: React.ComponentProps<typeof IssuesTab>) => {
    flushSync(() => {
      root.render(React.createElement(IssuesTab, nextProps))
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

describe('IssuesTab', () => {
  beforeEach(() => {
    fetchAgents.mockReset()
    fetchIssuesAndPRs.mockReset()
    fetchProjectConfig.mockReset()
    pushMock.mockReset()
    runAgent.mockReset()
    toastMock.mockReset()
    fetchAgents.mockResolvedValue({ agents: [] })
    fetchProjectConfig.mockResolvedValue(buildConfig())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads PRs and issues, reports counts, and shows cache metadata', async () => {
    const onCountChange = vi.fn()
    fetchIssuesAndPRs.mockResolvedValue({
      prs: [buildPullRequest()],
      issues: [buildIssue()],
      repo: 'acme/widgets',
      error: 'using cached GitHub data',
      cachedAt: Math.floor(Date.now() / 1000) - 60,
      cached: true,
    })

    const { container, unmount } = renderIssuesTab({
      projectName: 'acme/widgets',
      onCountChange,
    })

    await vi.waitFor(() => {
      expect(fetchIssuesAndPRs).toHaveBeenCalledWith('acme/widgets', false)
      expect(container.textContent).toContain('acme/widgets')
      expect(container.textContent).toContain('1 PR')
      expect(container.textContent).toContain('1 issue')
      expect(container.textContent).toContain('cached')
      expect(container.textContent).toContain('using cached GitHub data')
      expect(container.querySelector('[data-testid="pr-7"]')?.textContent).toContain('Stabilize pipeline retry')
      expect(container.querySelector('[data-testid="issue-42"]')?.getAttribute('data-config')).toBe('pnpm test')
    })

    expect(fetchProjectConfig).toHaveBeenCalledWith('acme/widgets')
    expect(onCountChange).toHaveBeenCalledWith({ prs: 1, issues: 1 })
    unmount()
  })

  it('forces a refresh when the refresh button is clicked', async () => {
    fetchIssuesAndPRs
      .mockResolvedValueOnce({
        prs: [],
        issues: [],
        repo: 'acme/widgets',
        error: null,
        cachedAt: null,
        cached: false,
      })
      .mockResolvedValueOnce({
        prs: [buildPullRequest({ number: 9, title: 'Refresh result' })],
        issues: [],
        repo: 'acme/widgets',
        error: null,
        cachedAt: null,
        cached: false,
      })

    const { container, unmount } = renderIssuesTab({
      projectName: 'acme/widgets',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Inbox zero')
    })

    const refreshButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Refresh'))
    refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchIssuesAndPRs).toHaveBeenNthCalledWith(2, 'acme/widgets', true)
      expect(container.querySelector('[data-testid="pr-9"]')?.textContent).toContain('Refresh result')
    })

    unmount()
  })

  it('shows the error state and retries the initial load', async () => {
    fetchIssuesAndPRs
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        prs: [],
        issues: [buildIssue({ number: 55, title: 'Retry succeeded' })],
        repo: 'acme/widgets',
        error: null,
        cachedAt: null,
        cached: false,
      })

    const { container, unmount } = renderIssuesTab({
      projectName: 'acme/widgets',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('boom')
    })

    const retryButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry')
    retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchIssuesAndPRs).toHaveBeenNthCalledWith(2, 'acme/widgets', false)
      expect(container.querySelector('[data-testid="issue-55"]')?.textContent).toContain('Retry succeeded')
    })

    unmount()
  })

  it('does not refetch project config when only onCountChange changes', async () => {
    fetchIssuesAndPRs
      .mockResolvedValueOnce({
        prs: [buildPullRequest()],
        issues: [buildIssue()],
        repo: 'acme/widgets',
        error: null,
        cachedAt: null,
        cached: false,
      })
      .mockResolvedValueOnce({
        prs: [buildPullRequest({ number: 8 })],
        issues: [buildIssue({ number: 56 })],
        repo: 'acme/widgets',
        error: null,
        cachedAt: null,
        cached: false,
      })

    const firstOnCountChange = vi.fn()
    const secondOnCountChange = vi.fn()
    const { rerender, unmount } = renderIssuesTab({
      projectName: 'acme/widgets',
      onCountChange: firstOnCountChange,
    })

    await vi.waitFor(() => {
      expect(fetchProjectConfig).toHaveBeenCalledTimes(1)
      expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1)
      expect(firstOnCountChange).toHaveBeenCalledWith({ prs: 1, issues: 1 })
    })

    rerender({
      projectName: 'acme/widgets',
      onCountChange: secondOnCountChange,
    })

    await vi.waitFor(() => {
      expect(fetchProjectConfig).toHaveBeenCalledTimes(1)
    })
    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1)

    const refreshButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Refresh'))
    refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchIssuesAndPRs).toHaveBeenNthCalledWith(2, 'acme/widgets', true)
      expect(secondOnCountChange).toHaveBeenCalledWith({ prs: 1, issues: 1 })
    })
    expect(firstOnCountChange).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('forwards jobsPaused to PR rows without refetching data', async () => {
    fetchIssuesAndPRs.mockResolvedValue({
      prs: [buildPullRequest()],
      issues: [],
      repo: 'acme/widgets',
      error: null,
      cachedAt: null,
      cached: false,
    })

    const { container, rerender, unmount } = renderIssuesTab({
      projectName: 'acme/widgets',
      jobsPaused: false,
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pr-7"]')?.getAttribute('data-jobs-paused')).toBe('false')
    })

    rerender({
      projectName: 'acme/widgets',
      jobsPaused: true,
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pr-7"]')?.getAttribute('data-jobs-paused')).toBe('true')
    })
    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1)

    unmount()
  })
})
