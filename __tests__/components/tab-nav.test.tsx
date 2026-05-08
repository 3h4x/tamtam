/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TabNav } from '@/components/project-detail/TabNav'

const { fetchJobsMock, pushMock } = vi.hoisted(() => ({
  fetchJobsMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

function renderTabNav(overrides: Partial<React.ComponentProps<typeof TabNav>> = {}) {
  const onSetTab = vi.fn()
  const props: React.ComponentProps<typeof TabNav> = {
    projectName: 'owner/repo name',
    activeTab: 'overview',
    totalChanges: 0,
    issueCount: null,
    runningCount: 0,
    onSetTab,
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(TabNav, props))
  })

  return {
    container,
    onSetTab,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('TabNav', () => {
  beforeEach(() => {
    fetchJobsMock.mockReset()
    pushMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('routes directly to the latest terminal session when one exists', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        { kind: 'test', session_id: 'ignore', started_at: 300 },
        { kind: 'run', session_id: 'older', started_at: 100 },
        { kind: 'run', session_id: 'latest', started_at: 200 },
      ],
    })

    const { container, onSetTab, unmount } = renderTabNav()
    const terminalButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Terminal'))
    terminalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()

    expect(fetchJobsMock).toHaveBeenCalledWith('owner/repo name')
    expect(pushMock).toHaveBeenCalledWith('/project/owner/repo name/terminal/latest')
    expect(onSetTab).not.toHaveBeenCalled()

    unmount()
  })

  it('falls back to the terminal tab when loading sessions fails', async () => {
    fetchJobsMock.mockRejectedValue(new Error('boom'))

    const { container, onSetTab, unmount } = renderTabNav()
    const terminalButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Terminal'))
    terminalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()

    expect(pushMock).not.toHaveBeenCalled()
    expect(onSetTab).toHaveBeenCalledWith('terminal')

    unmount()
  })

  it('renders change, history, and issue badges from live counts', () => {
    const { container, unmount } = renderTabNav({
      totalChanges: 3,
      runningCount: 2,
      issueCount: { prs: 4, issues: 1 },
    })

    expect(container.textContent).toContain('Changes')
    expect(container.textContent).toContain('3')
    expect(container.querySelector('[title="2 running"]')).toBeTruthy()
    expect(container.textContent).toContain('5')

    unmount()
  })
})
