/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectTablePage } from '@/components/ProjectTablePage'
import type { FleetHealth } from '@/hooks/useProjectHealth'

const push = vi.fn()

const { fetchJobs, fetchAgents, reviewProject } = vi.hoisted(() => ({
  fetchJobs: vi.fn(),
  fetchAgents: vi.fn(),
  reviewProject: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs,
  fetchAgents,
  reviewProject,
}))

function createFleetHealth(projects: FleetHealth['projects']): FleetHealth {
  return {
    projects,
    errorCount: 0,
    warningCount: 0,
    healthyCount: projects.length,
    unknownCount: 0,
    totalTasks: projects.reduce((sum, project) => sum + project.tasks.length, 0),
    totalChanges: projects.reduce((sum, project) => sum + project.totalChanges, 0),
    totalUnreviewed: projects.reduce((sum, project) => sum + project.unreviewedCount, 0),
  }
}

function renderProjectTablePage(props: React.ComponentProps<typeof ProjectTablePage>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ProjectTablePage, props))
  })

  return {
    container,
    rerender: (nextProps: React.ComponentProps<typeof ProjectTablePage>) => {
      flushSync(() => {
        root.render(React.createElement(ProjectTablePage, nextProps))
      })
    },
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('ProjectTablePage', () => {
  beforeEach(() => {
    push.mockReset()
    fetchJobs.mockReset()
    fetchAgents.mockReset()
    reviewProject.mockReset()
    fetchJobs.mockResolvedValue({ jobs: [] })
    fetchAgents.mockResolvedValue({ agents: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ internal: { entries: [], paused: false } }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows the loading overlay only for the empty bootstrap state', async () => {
    const fleet = createFleetHealth([])
    const { container, rerender, unmount } = renderProjectTablePage({
      fleet,
      issueCounts: {},
      loading: true,
    })

    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()

    const loadedFleet = createFleetHealth([
      {
        project: 'acme/widgets',
        status: 'healthy',
        tasks: [{
          task: {
            id: 'task-1',
            project: 'acme/widgets',
            job: 'nightly',
            priority: 'medium',
            launchctl: 'running',
            path: '/tmp/acme/widgets',
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
          },
          status: 'healthy',
          summary: 'nightly healthy',
        }],
        totalChanges: 0,
        unpushed: 0,
        unreviewedCount: 0,
        lastRunAgo: null,
      },
    ])

    rerender({
      fleet: loadedFleet,
      issueCounts: {},
      loading: true,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('acme/widgets')
      expect(container.querySelectorAll('.skeleton')).toHaveLength(0)
      expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    })

    unmount()
  })
})
