/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useAgentStats, type AgentStat } from '@/hooks/useAgentStats'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function stat(name: string): AgentStat {
  return {
    name,
    runs: 1,
    finishedRuns: 1,
    successfulRuns: 1,
    avgDurationMs: 1000,
    totalDurationMs: 1000,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0.01,
    modifiedFilesCount: 1,
    reviewFixesTriggered: 0,
  }
}

function response(agents: AgentStat[]) {
  return {
    ok: true,
    json: async () => ({ agents }),
  } as Response
}

function errorResponse() {
  return {
    ok: false,
    json: async () => ({}),
  } as Response
}

function Harness({ projectName }: { projectName: string }) {
  const { byName, loading } = useAgentStats(projectName, 600_000)
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="entries">{Array.from(byName.keys()).join(',')}</span>
    </div>
  )
}

describe('useAgentStats', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('ignores stale responses after the project changes', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(<Harness projectName="alpha" />)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/stats?project=alpha')

    flushSync(() => {
      root.render(<Harness projectName="beta" />)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/stats?project=beta')

    second.resolve(response([stat('beta-agent')]))
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('beta-agent')
    })

    first.resolve(response([stat('alpha-agent')]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('beta-agent')

    flushSync(() => root.unmount())
    container.remove()
  })

  it('does not keep prior project stats when the next project fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response([stat('alpha-agent')]))
      .mockResolvedValueOnce(errorResponse())

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(<Harness projectName="alpha" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('alpha-agent')
    })

    flushSync(() => {
      root.render(<Harness projectName="beta" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('')
    })

    flushSync(() => root.unmount())
    container.remove()
  })

  it('does not keep prior project stats when the next project request rejects', async () => {
    fetchMock
      .mockResolvedValueOnce(response([stat('alpha-agent')]))
      .mockRejectedValueOnce(new Error('network down'))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(<Harness projectName="alpha" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('alpha-agent')
    })

    flushSync(() => {
      root.render(<Harness projectName="beta" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('')
    })

    flushSync(() => root.unmount())
    container.remove()
  })
})
