/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TaskDetailPage } from '@/components/TaskDetailPage'
import type { TaskDetail } from '@/lib/client-api'
import type { FleetHealth } from '@/hooks/useProjectHealth'
import type { Task } from '@/lib/shared/types'

const { fetchTaskDetailMock, pushMock } = vi.hoisted(() => ({
  fetchTaskDetailMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'task-detail-live', task: 'review' }),
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchTaskDetail: fetchTaskDetailMock,
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

function makeTask(): Task {
  return {
    id: 'task-detail-live-review',
    project: 'task-detail-live',
    job: 'review',
    priority: null,
    paused: false,
    path: '/tmp/task-detail-live',
    fires_at: '*/5 * * * *',
    sync: true,
    changes: 0,
    unpushed: 0,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
  }
}

function makeFleet(): FleetHealth {
  const task = makeTask()
  return {
    projects: [{
      project: task.project,
      status: 'healthy',
      tasks: [{ task, status: 'healthy', summary: 'review' }],
      totalChanges: 0,
      unpushed: 0,
      unreviewedCount: 0,
      lastRunAgo: null,
    }],
    errorCount: 0,
    warningCount: 0,
    healthyCount: 1,
    unknownCount: 0,
    totalTasks: 1,
    totalChanges: 0,
    totalUnreviewed: 0,
  }
}

function runningDetail(): TaskDetail {
  return {
    id: 'task-detail-live-review',
    project: 'task-detail-live',
    job: 'review',
    prompt_path: null,
    prompt_content: null,
    memory_path: null,
    memory_content: null,
    persona: [],
    run_history: [{
      started: '2026-05-28T10:00:00.000Z',
      ended: null,
      duration_s: null,
      exit_code: null,
    }],
  }
}

function finishedDetail(): TaskDetail {
  return {
    ...runningDetail(),
    run_history: [{
      started: '2026-05-28T10:00:00.000Z',
      ended: '2026-05-28T10:00:12.000Z',
      duration_s: 12,
      exit_code: 0,
    }],
  }
}

function cancelledDetail(exitCode: -2 | -3): TaskDetail {
  return {
    ...runningDetail(),
    run_history: [{
      started: '2026-05-28T10:00:00.000Z',
      ended: '2026-05-28T10:00:12.000Z',
      duration_s: 12,
      exit_code: exitCode,
    }],
  }
}

describe('TaskDetailPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchTaskDetailMock.mockReset()
    pushMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('ignores stale detail responses that resolve after a newer poll', async () => {
    const first = deferred<TaskDetail>()
    const second = deferred<TaskDetail>()
    fetchTaskDetailMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(
        <TaskDetailPage
          fleet={makeFleet()}
          priorities={[]}
          onPriorityChange={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
        />,
      )
    })

    await vi.waitFor(() => {
      expect(fetchTaskDetailMock).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(5000)

    expect(fetchTaskDetailMock).toHaveBeenCalledTimes(2)

    second.resolve(finishedDetail())
    await second.promise

    await vi.waitFor(() => {
      expect(container.textContent).toContain('12s')
      expect(container.textContent).toContain('0')
    })

    first.resolve(runningDetail())
    await first.promise

    expect(container.textContent).toContain('12s')
    expect(container.textContent).toContain('0')
    expect(container.textContent).not.toContain('running...')

    flushSync(() => root.unmount())
  })

  it('renders stopped jobs with exit code -2 as cancelled', async () => {
    fetchTaskDetailMock.mockResolvedValueOnce(cancelledDetail(-2))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(
        <TaskDetailPage
          fleet={makeFleet()}
          priorities={[]}
          onPriorityChange={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
        />,
      )
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('cancelled')
    })

    expect(container.textContent).not.toContain('-2')

    flushSync(() => root.unmount())
  })
})
