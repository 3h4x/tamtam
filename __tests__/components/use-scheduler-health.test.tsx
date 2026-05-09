/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useSchedulerHealth, type SchedulerEntry } from '@/hooks/useSchedulerHealth'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function response(entries: SchedulerEntry[]) {
  return {
    ok: true,
    json: async () => ({ internal: { entries } }),
  } as Response
}

function errorResponse() {
  return {
    ok: false,
    json: async () => ({}),
  } as Response
}

const alphaEntry: SchedulerEntry = {
  agentId: 'agent-alpha',
  project: 'alpha',
  name: 'alpha-agent',
  schedule: '1h',
  enabled: true,
  nextFireMs: 1,
  lastFireMs: null,
  fireCount: 0,
  errorCount: 0,
  lastError: null,
  skippedCount: 0,
  lastSkippedReason: null,
  lastJobMs: null,
}

const betaEntry: SchedulerEntry = {
  ...alphaEntry,
  agentId: 'agent-beta',
  project: 'beta',
  name: 'beta-agent',
}

function Harness({ projectName }: { projectName: string }) {
  const { entries, loading } = useSchedulerHealth(projectName, 600_000)
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="entries">{entries.map(e => e.name).join(',')}</span>
    </div>
  )
}

describe('useSchedulerHealth', () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1)

    flushSync(() => {
      root.render(<Harness projectName="beta" />)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    second.resolve(response([alphaEntry, betaEntry]))
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('beta-agent')
    })

    first.resolve(response([alphaEntry]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
    expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe('beta-agent')

    flushSync(() => root.unmount())
    container.remove()
  })

  it('does not keep prior project entries when the next project fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response([alphaEntry]))
      .mockResolvedValueOnce(errorResponse())

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(<Harness projectName="alpha" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
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

  it('does not keep prior project entries when the next project request rejects', async () => {
    fetchMock
      .mockResolvedValueOnce(response([alphaEntry]))
      .mockRejectedValueOnce(new Error('network down'))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => {
      root.render(<Harness projectName="alpha" />)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready')
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
