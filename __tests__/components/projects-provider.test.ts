/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectsProvider, useProjects } from '@/components/ProjectsProvider'
import type { ProjectsResponse } from '@/lib/shared/types'

const { fetchProjects, pauseProject, resumeProject, setPriority } = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  pauseProject: vi.fn(),
  resumeProject: vi.fn(),
  setPriority: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchProjects,
  pauseProject,
  resumeProject,
  setPriority,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function buildProjectsResponse(projectName = 'acme/widgets'): ProjectsResponse {
  return {
    tasks: [{
      id: 'task-1',
      project: projectName,
      job: 'nightly',
      priority: 'medium',
      launchctl: 'running',
      path: `/tmp/${projectName}`,
      fires_at: '* * * * *',
      sync: true,
      changes: 0,
      unpushed: 0,
      reviewed: true,
      last_run: null,
      last_run_ago: null,
      last_run_duration_s: null,
      last_run_exit: null,
      release_tag: null,
      ci: 'success',
      ci_failed_url: null,
      github: null,
    }],
    priorities: ['medium'],
    issueCounts: { [projectName]: { prs: 0, issues: 0 } },
  }
}

function Probe() {
  const { tasks, loading, refreshing, handlePause } = useProjects()

  return React.createElement(
    'div',
    null,
    React.createElement('div', { 'data-testid': 'state' }, loading ? 'loading' : refreshing ? 'refreshing' : 'idle'),
    React.createElement('div', { 'data-testid': 'projects' }, tasks.map(task => task.project).join(',')),
    React.createElement(
      'button',
      { type: 'button', onClick: () => { void handlePause('task-1') } },
      'pause',
    ),
  )
}

function renderProvider() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(
      React.createElement(
        ProjectsProvider,
        null,
        React.createElement(Probe),
      ),
    )
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('ProjectsProvider', () => {
  beforeEach(() => {
    fetchProjects.mockReset()
    pauseProject.mockReset()
    resumeProject.mockReset()
    setPriority.mockReset()
    pauseProject.mockResolvedValue(undefined)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('uses refreshing instead of loading during reloads after a project mutation', async () => {
    const initialLoad = deferred<ProjectsResponse>()
    const refreshLoad = deferred<ProjectsResponse>()
    fetchProjects
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(refreshLoad.promise)

    const { container, unmount } = renderProvider()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('loading')
    })

    initialLoad.resolve(buildProjectsResponse())

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('idle')
      expect(container.querySelector('[data-testid="projects"]')?.textContent).toContain('acme/widgets')
    })

    const pauseButton = container.querySelector('button')
    pauseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pauseProject).toHaveBeenCalledWith('task-1')
      expect(fetchProjects).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('refreshing')
      expect(container.querySelector('[data-testid="projects"]')?.textContent).toContain('acme/widgets')
    })

    refreshLoad.resolve(buildProjectsResponse('acme/renamed'))

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('idle')
      expect(container.querySelector('[data-testid="projects"]')?.textContent).toContain('acme/renamed')
    })

    unmount()
  })
})
