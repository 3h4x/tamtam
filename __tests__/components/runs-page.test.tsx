/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RunsPage } from '@/components/project-runs/RunsPage'
import type { JobInfo } from '@/lib/client-api'

const { fetchJobsMock, pushJobsResolver } = vi.hoisted(() => {
  type JobsResponse = { jobs: JobInfo[]; total?: number; pendingReleaseProjects?: string[] }
  type Resolver = {
    resolve: (value: JobsResponse) => void
    reject: (error: Error) => void
  }
  const resolvers: Resolver[] = []
  return {
    fetchJobsMock: vi.fn(() => new Promise<JobsResponse>((resolve, reject) => {
      resolvers.push({ resolve, reject })
    })),
    pushJobsResolver: {
      next: () => {
        const resolver = resolvers.shift()
        if (!resolver) throw new Error('No pending fetchJobs resolver')
        return resolver
      },
      reset: () => {
        resolvers.length = 0
      },
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
}))

function makeJob(
  id: string,
  prompt: string,
  startedAt: number,
  overrides: Partial<JobInfo> = {},
): JobInfo {
  return {
    id,
    project: 'proj1',
    kind: 'run',
    prompt,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: startedAt,
    finished_at: startedAt + 5,
    seen: true,
    duration_ms: 5000,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    session_id: null,
    user_prompt: prompt,
    context_meta: null,
    log_pruned: false,
    cost_usd: 0,
    model: null,
    release_id: null,
    parent_job_id: null,
    work_summary: null,
    detail: null,
    modified_files: null,
    provider: null,
    prompt_bytes: null,
    parent_kind: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  }
}

async function waitForCondition(assertion: () => void): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < 1000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function renderRunsPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(RunsPage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('RunsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/projects') {
        return jsonResponse({ tasks: [{ project: 'proj1' }] })
      }
      if (url.startsWith('/api/jobs/counts')) {
        return jsonResponse({
          total: 1,
          byKind: { run: 1 },
          byStatus: { running: 0, done: 1, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    vi.stubGlobal('scrollTo', vi.fn())
    fetchJobsMock.mockClear()
    pushJobsResolver.reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('ignores stale runs responses after filters change', async () => {
    const { container, unmount } = renderRunsPage()

    await waitForCondition(() => {
      expect(fetchJobsMock).toHaveBeenCalledTimes(1)
    })
    const stale = pushJobsResolver.next()

    const dateSelect = container.querySelector('select[aria-label="Date filter"]') as HTMLSelectElement | null
    expect(dateSelect).toBeInstanceOf(HTMLSelectElement)
    dateSelect!.value = '24h'
    dateSelect!.dispatchEvent(new Event('change', { bubbles: true }))

    await waitForCondition(() => {
      expect(fetchJobsMock).toHaveBeenCalledTimes(2)
    })
    const current = pushJobsResolver.next()

    current.resolve({ jobs: [makeJob('current', 'current run', 2000)], total: 1 })

    await waitForCondition(() => {
      expect(container.textContent).toContain('current run')
    })

    stale.resolve({ jobs: [makeJob('stale', 'stale run', 1000)], total: 1 })

    await waitForCondition(() => {
      expect(container.textContent).not.toContain('stale run')
      expect(container.textContent).toContain('current run')
    })

    unmount()
  })

  it('groups release children and expands pipeline steps', async () => {
    const { container, unmount } = renderRunsPage()

    await waitForCondition(() => {
      expect(fetchJobsMock).toHaveBeenCalledTimes(1)
    })
    const current = pushJobsResolver.next()
    current.resolve({
      jobs: [
        makeJob('rel-1', 'release', 1000, {
          kind: 'release',
          finished_at: 1100,
        }),
        makeJob('test-1', 'test', 1010, {
          kind: 'test',
          prompt: 'test prompt',
          user_prompt: 'test prompt',
          release_id: 'rel-1',
          parent_job_id: 'rel-1',
        }),
        makeJob('review-1', 'review', 1020, {
          kind: 'review',
          prompt: 'review prompt',
          user_prompt: 'review prompt',
          release_id: 'rel-1',
          parent_job_id: 'test-1',
          verdict: 'LGTM',
        }),
      ],
      total: 3,
    })

    await waitForCondition(() => {
      expect(container.textContent).toContain('Release pipeline')
      expect(container.textContent).not.toContain('Tests passed')
    })

    const expand = container.querySelector('button[title="Expand steps"]') as HTMLButtonElement | null
    expect(expand).toBeInstanceOf(HTMLButtonElement)
    expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await waitForCondition(() => {
      expect(container.textContent).toContain('Tests passed')
      expect(container.textContent).toContain('✓ LGTM')
    })

    unmount()
  })

  it('nests agent-owned releases under the originating agent row', async () => {
    const { container, unmount } = renderRunsPage()

    await waitForCondition(() => {
      expect(fetchJobsMock).toHaveBeenCalledTimes(1)
    })
    const current = pushJobsResolver.next()
    current.resolve({
      jobs: [
        makeJob('agent-1', 'agent run', 1000, {
          kind: 'agent:builder',
          finished_at: 1010,
        }),
        makeJob('rel-1', 'release', 1020, {
          kind: 'release',
          finished_at: 1060,
          parent_job_id: 'agent-1',
        }),
        makeJob('test-1', 'test', 1030, {
          kind: 'test',
          release_id: 'rel-1',
          parent_job_id: 'rel-1',
        }),
      ],
      total: 3,
    })

    await waitForCondition(() => {
      expect(container.textContent).toContain('builder')
      expect(container.textContent).toContain('release done')
      expect(container.textContent).not.toContain('Release pipeline')
      expect(container.textContent).not.toContain('Tests passed')
    })

    const expand = container.querySelector('button[title="Expand steps"]') as HTMLButtonElement | null
    expect(expand).toBeInstanceOf(HTMLButtonElement)
    expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await waitForCondition(() => {
      expect(container.textContent).toContain('Tests passed')
    })

    unmount()
  })
})
