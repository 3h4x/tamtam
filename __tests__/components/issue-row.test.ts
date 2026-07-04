/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { IssueRow } from '@/components/issues-tab/IssueRow'
import type { GhIssue, ProjectConfig } from '@/lib/client-api'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

function buildIssue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 42,
    title: 'Handle retry edge case',
    state: 'OPEN',
    author: { login: 'octocat' },
    url: 'https://github.com/acme/widgets/issues/42',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
    assignees: [{ login: 'alice' }, { login: 'bob' }],
    labels: [{ name: 'bug', color: 'ff0000' }],
    body: 'Issue body text',
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
    auto_pr_merge_enabled: true,
    release_after_run: true,
    issue_auto_branch: false,
    tests_disabled: false,
    review_disabled: false,
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  }
}

function renderIssueRow(props: React.ComponentProps<typeof IssueRow>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(IssueRow, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('IssueRow', () => {
  beforeEach(() => {
    push.mockReset()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens a new work-on session and stashes the issue metadata when no prior context exists', async () => {
    // hasContext is now folded into the issue payload (no per-row fetch on
    // mount), so an unset flag means "Work on", not "Continue".
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderIssueRow({
      issue: buildIssue(),
      projectName: 'acme/widgets',
      projectCfg: buildConfig(),
      onOpen: () => {},
      onClosed: () => {},
    })

    const workOn = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Work on')
    expect(workOn?.getAttribute('title')).toContain('auto-push + PR (off)')

    workOn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(push).toHaveBeenCalledTimes(1)
    const pendingUrl = push.mock.calls[0][0] as string
    expect(pendingUrl).toMatch(/^\/project\/acme\/widgets\/terminal\?pending=/)
    const pendingKey = pendingUrl.split('pending=')[1]
    const payload = JSON.parse(sessionStorage.getItem(pendingKey) ?? '{}')
    expect(payload.issue_number).toBe('42')
    expect(payload.issue_repo).toBe('acme/widgets')
    expect(payload.issue_title).toBe('Handle retry edge case')
    expect(payload.prompt).toContain('Work on GitHub issue #42')
    unmount()
  })

  it('shows Continue when prior context exists and resumes the saved session payload', async () => {
    // The Continue affordance now comes from issue.hasContext; the only fetch
    // is the continue-issue lookup fired on click.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'sess-123', provider: 'codex', prompt: 'resume prompt', unverifiedCount: 2 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderIssueRow({
      issue: buildIssue({ hasContext: true }),
      projectName: 'acme/widgets',
      projectCfg: buildConfig(),
      onOpen: () => {},
      onClosed: () => {},
    })

    await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Continue'))
      expect(button).toBeTruthy()
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Continue'))
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    const pendingUrl = push.mock.calls[0][0] as string
    const pendingKey = pendingUrl.split('pending=')[1]
    const payload = JSON.parse(sessionStorage.getItem(pendingKey) ?? '{}')
    expect(payload.prompt).toBe('resume prompt')
    expect(payload.resume_session_id).toBe('sess-123')
    expect(payload.resume_provider).toBe('codex')
    expect(payload.issue_repo).toBe('acme/widgets')
    unmount()
  })

  it('falls back to a plain work-on payload when continue lookup fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderIssueRow({
      issue: buildIssue({ hasContext: true }),
      projectName: 'acme/widgets',
      projectCfg: buildConfig(),
      onOpen: () => {},
      onClosed: () => {},
    })

    await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Continue'))
      expect(button).toBeTruthy()
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Continue'))
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    const pendingKey = (push.mock.calls[0][0] as string).split('pending=')[1]
    const payload = JSON.parse(sessionStorage.getItem(pendingKey) ?? '{}')
    expect(payload.resume_session_id).toBeUndefined()
    expect(payload.resume_provider).toBeUndefined()
    expect(payload.prompt).toContain('Work on GitHub issue #42')
    unmount()
  })

  it('keeps the fourth label visible before collapsing into overflow', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const { container, unmount } = renderIssueRow({
      issue: buildIssue({
        labels: [
          { name: 'bug', color: 'ff0000' },
          { name: 'urgent', color: 'ffaa00' },
          { name: 'backend', color: '0000ff' },
          { name: 'release-blocker', color: 'aa00aa' },
          { name: 'needs-triage', color: '00aa88' },
        ],
      }),
      projectName: 'acme/widgets',
      projectCfg: buildConfig(),
      onOpen: () => {},
      onClosed: () => {},
    })

    expect(container.textContent).toContain('bug')
    expect(container.textContent).toContain('urgent')
    expect(container.textContent).toContain('backend')
    expect(container.textContent).toContain('release-blocker')
    expect(container.textContent).not.toContain('needs-triage')
    expect(container.querySelector('[title="needs-triage"]')?.textContent).toBe('+1')
    unmount()
  })
})
