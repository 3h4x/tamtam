/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectActions } from '@/components/project-detail/ProjectActions'
import type { ProjectConfig } from '@/lib/client-api'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

function buildConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: 'acme/widgets',
    test_command: 'pnpm test',
    detected_test_command: 'pnpm test',
    effective_test_command: 'pnpm test',
    test_cron_enabled: false,
    test_cron_schedule: '0 * * * *',
    auto_commit_enabled: false,
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

function buildProps(overrides: Partial<React.ComponentProps<typeof ProjectActions>> = {}): React.ComponentProps<typeof ProjectActions> {
  return {
    projectName: 'acme/widgets',
    totalChanges: 2,
    unpushed: 0,
    aggregateCi: null,
    ciFailedUrl: null,
    githubUrl: null,
    websiteUrl: null,
    jobsPaused: false,
    config: buildConfig(),
    verdict: undefined,
    hasUnreviewed: false,
    isPipelineRunning: false,
    isTestRunning: false,
    isCiFixRunning: false,
    fixingCi: false,
    fixCiResult: null,
    releasing: false,
    testing: false,
    creatingPr: false,
    currentBranch: 'fix/issue-77-gates',
    defaultBranch: 'master',
    branchCommitsAhead: 1,
    openPrBranches: ['fix/issue-77-gates'],
    customActions: [],
    runningActions: new Set(),
    onFixCi: vi.fn(),
    onRelease: vi.fn(),
    onCreatePr: vi.fn(),
    onTest: vi.fn(),
    onCustomAction: vi.fn(),
    ...overrides,
  }
}

function renderProjectActions(props: React.ComponentProps<typeof ProjectActions>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextProps: React.ComponentProps<typeof ProjectActions>) => {
    flushSync(() => {
      root.render(React.createElement(ProjectActions, nextProps))
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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('ProjectActions', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('disables fix-ci, release, and test while jobs are paused', () => {
    const { container, rerender, unmount } = renderProjectActions(buildProps({
      jobsPaused: true,
      aggregateCi: 'failure',
      ciFailedUrl: 'https://github.com/acme/widgets/actions/runs/1',
    }))

    expect(buttonByText(container, 'Fix CI').disabled).toBe(true)
    expect(buttonByText(container, 'Release').disabled).toBe(true)
    expect(buttonByText(container, 'Test').disabled).toBe(true)
    expect(buttonByText(container, 'Fix CI').title).toContain('Jobs are paused globally')
    expect(buttonByText(container, 'Release').title).toContain('Jobs are paused globally')
    expect(buttonByText(container, 'Test').title).toContain('Jobs are paused globally')

    rerender(buildProps({
      jobsPaused: false,
      aggregateCi: 'failure',
      ciFailedUrl: 'https://github.com/acme/widgets/actions/runs/1',
    }))

    expect(buttonByText(container, 'Fix CI').disabled).toBe(false)
    expect(buttonByText(container, 'Release').disabled).toBe(false)
    expect(buttonByText(container, 'Test').disabled).toBe(false)

    unmount()
  })

  it('renders no manual git push/pull/push-to-pr buttons — shipping goes through Release', () => {
    const { container, unmount } = renderProjectActions(buildProps({
      totalChanges: 0,
      unpushed: 3,
      currentBranch: 'master',
      openPrBranches: [],
    }))

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
    expect(labels.some((l) => /^Push/i.test(l))).toBe(false)
    expect(labels.some((l) => /^Pull/i.test(l))).toBe(false)
    expect(labels.some((l) => /Push to PR/i.test(l))).toBe(false)
    expect(labels.some((l) => l === 'Rebase' || l === 'Merge')).toBe(false)
    // Release remains and is enabled (there are unpushed commits to ship).
    expect(buttonByText(container, 'Release').disabled).toBe(false)

    unmount()
  })

  it('disables custom actions while jobs are paused and re-enables them live', () => {
    const { container, rerender, unmount } = renderProjectActions(buildProps({
      jobsPaused: true,
      customActions: [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }],
    }))

    expect(buttonByText(container, 'Deploy').disabled).toBe(true)
    expect(buttonByText(container, 'Deploy').title).toContain('Jobs are paused globally')

    rerender(buildProps({
      jobsPaused: false,
      customActions: [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }],
    }))

    expect(buttonByText(container, 'Deploy').disabled).toBe(false)
    expect(buttonByText(container, 'Deploy').title).toContain('Run: pnpm deploy')

    unmount()
  })

  it('renders website and github external links when provided', () => {
    const { container, unmount } = renderProjectActions(buildProps({
      websiteUrl: 'https://example.com',
      githubUrl: 'https://github.com/acme/widgets',
    }))

    const links = Array.from(container.querySelectorAll('a'))
    const websiteLink = links.find((a) => a.textContent?.includes('Website'))
    const githubLink = links.find((a) => a.textContent?.includes('GitHub'))

    expect(websiteLink).toBeTruthy()
    expect(websiteLink?.getAttribute('href')).toBe('https://example.com')
    expect(websiteLink?.getAttribute('target')).toBe('_blank')
    expect(websiteLink?.getAttribute('rel')).toContain('noopener')

    expect(githubLink).toBeTruthy()
    expect(githubLink?.getAttribute('href')).toBe('https://github.com/acme/widgets')
    expect(githubLink?.getAttribute('target')).toBe('_blank')

    unmount()
  })

  it('omits website and github links when urls are null', () => {
    const { container, unmount } = renderProjectActions(buildProps({
      websiteUrl: null,
      githubUrl: null,
    }))

    const links = Array.from(container.querySelectorAll('a'))
    expect(links.find((a) => a.textContent?.includes('Website'))).toBeUndefined()
    expect(links.find((a) => a.textContent?.includes('GitHub'))).toBeUndefined()

    unmount()
  })

  it('shows Ship (LGTM) button on fresh LGTM and fires onRelease', () => {
    const onRelease = vi.fn()
    const { container, unmount } = renderProjectActions(buildProps({
      verdict: 'LGTM',
      hasUnreviewed: false,
      totalChanges: 3,
      onRelease,
    }))

    const shipBtn = buttonByText(container, 'Ship (LGTM)')
    expect(shipBtn.disabled).toBe(false)
    expect(shipBtn.title).toContain('review already LGTM')
    shipBtn.click()
    expect(onRelease).toHaveBeenCalledOnce()

    unmount()
  })

  it('disables release with nothing-to-release title when no changes and no unpushed commits', () => {
    const { container, unmount } = renderProjectActions(buildProps({
      totalChanges: 0,
      unpushed: 0,
      currentBranch: 'master',
      openPrBranches: [],
    }))

    const releaseBtn = buttonByText(container, 'Release')
    expect(releaseBtn.disabled).toBe(true)
    expect(releaseBtn.title).toContain('Nothing to release')

    unmount()
  })
})
