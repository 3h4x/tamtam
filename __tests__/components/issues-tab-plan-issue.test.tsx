/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { IssuesTab } from '@/components/IssuesTab'
import { ISSUE_FORMAT_INSTRUCTION } from '@/lib/agents/issue-template'
import type { Agent } from '@/lib/client-api'

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
  PRRow: () => null,
}))

vi.mock('@/components/issues-tab/IssueRow', () => ({
  IssueRow: () => null,
}))

function ctoAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-cto-1',
    name: 'cto',
    project: 'alpha',
    skillIds: ['agent-cto'],
    docPaths: [],
    model: 'smart',
    prompt: '',
    schedule: '24h',

    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function renderTab(props: Partial<React.ComponentProps<typeof IssuesTab>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(IssuesTab, { projectName: 'alpha', ...props }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('IssuesTab issue planning panel', () => {
  beforeEach(() => {
    fetchAgents.mockReset()
    fetchIssuesAndPRs.mockReset()
    fetchProjectConfig.mockReset()
    pushMock.mockReset()
    runAgent.mockReset()
    toastMock.mockReset()
    fetchIssuesAndPRs.mockResolvedValue({
      prs: [],
      issues: [],
      repo: 'acme/widgets',
      error: null,
      cachedAt: null,
      cached: false,
    })
    fetchProjectConfig.mockResolvedValue({
      project: 'alpha',
      effective_test_command: 'pnpm test',
    })
    runAgent.mockResolvedValue({
      status: 'started',
      job_id: 'job-123',
      pid: 99999,
      agent: 'cto',
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('runs the cto agent with the typed idea as a read-only task prompt', async () => {
    fetchAgents.mockResolvedValue({ agents: [ctoAgent()] })
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Plan a GitHub issue')
    })

    const textarea = container.querySelector('textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea not found')
    setTextareaValue(textarea, 'Add project-specific token quota overrides for heavy repos')

    const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Plan issue'))
    if (!(button instanceof HTMLButtonElement)) throw new Error('plan button not found')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalledWith(
        'agent-cto-1',
        expect.stringContaining('Add project-specific token quota overrides for heavy repos'),
        { readOnly: true },
      )
    })
    const prompt = runAgent.mock.calls[0][1] as string
    expect(prompt).toContain('docs/*.md')
    expect(prompt).toContain('gh issue list --limit 50 --state open')
    expect(prompt).toContain('already implemented')
    expect(prompt).toContain('gh issue create')
    expect(prompt).toContain('human-needed')
    expect(prompt).toContain('Do not run `git`')
    expect(prompt).toContain(ISSUE_FORMAT_INSTRUCTION)
    expect(prompt).toContain('## Problem')
    expect(prompt).toContain('## Proposed approach')
    expect(prompt).toContain('## Acceptance criteria')
    expect(prompt).toContain('- [ ]')
    expect(pushMock).toHaveBeenCalledWith('/project/alpha/terminal?job=job-123')

    unmount()
  })

  it('shows the disabled setup notice when the project has no cto agent', async () => {
    fetchAgents.mockResolvedValue({ agents: [] })
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Add the cto agent')
    })

    expect(container.querySelector('textarea')).toBeNull()
    expect(runAgent).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps the draft editable while blocking issue planning when jobs are paused', async () => {
    fetchAgents.mockResolvedValue({ agents: [ctoAgent()] })
    const { container, unmount } = renderTab({ jobsPaused: true })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Plan a GitHub issue')
    })

    const textarea = container.querySelector('textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea not found')
    expect(textarea.disabled).toBe(false)
    setTextareaValue(textarea, 'Keep local drafting available while global jobs are paused')
    expect(textarea.value).toBe('Keep local drafting available while global jobs are paused')

    const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Plan issue'))
    if (!(button instanceof HTMLButtonElement)) throw new Error('plan button not found')
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Jobs are paused globally. Resume jobs to plan an issue.')

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true }))

    expect(runAgent).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()

    unmount()
  })
})
