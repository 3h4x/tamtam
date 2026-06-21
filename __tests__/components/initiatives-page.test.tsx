/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { InitiativesPage } from '@/components/InitiativesPage'

vi.mock('next/link', () => ({
  default: ({ children, href, className }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}))

function makeResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<InitiativesPage embedded />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const fastWaitFor = (callback: Parameters<typeof vi.waitFor>[0]) =>
  vi.waitFor(callback, { timeout: 500, interval: 1 })

describe('InitiativesPage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    const now = Date.now()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/initiatives') {
        return makeResponse({
          generatedAt: now,
          flags: {
            engineEnabled: true,
            miningEnabled: true,
            maxShipsPerDay: 3,
            maxBacklogPerProject: 50,
          },
          counts: {
            proposed: 0,
            queued: 1,
            running: 1,
            shipped: 1,
            failed: 0,
            rejected: 1,
            superseded: 0,
          },
          initiatives: [
            {
              id: 1,
              project: 'alpha',
              source: 'mining',
              kind: 'lint',
              title: 'Queued item',
              rationale: 'r',
              score: 100,
              status: 'queued',
              releaseId: null,
              pinnedAt: null,
              updatedAt: now,
            },
            {
              id: 2,
              project: 'alpha',
              source: 'mining',
              kind: 'lint',
              title: 'Running item',
              rationale: 'r',
              score: 100,
              status: 'running',
              releaseId: 'agent-1',
              pinnedAt: null,
              updatedAt: now,
            },
            {
              id: 3,
              project: 'alpha',
              source: 'mining',
              kind: 'lint',
              title: 'Shipped item',
              rationale: 'r',
              score: 100,
              status: 'shipped',
              releaseId: 'release-1',
              pinnedAt: null,
              updatedAt: now,
            },
            {
              id: 4,
              project: 'alpha',
              source: 'mining',
              kind: 'lint',
              title: 'Rejected item',
              rationale: 'r',
              score: 100,
              status: 'rejected',
              releaseId: null,
              pinnedAt: null,
              updatedAt: now,
            },
          ],
        })
      }
      if (url === '/api/projects') {
        return makeResponse({ tasks: [] })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders mutation controls only for curatable initiative states', async () => {
    const { container, unmount } = renderPage()

    await fastWaitFor(() => {
      expect(container.textContent).toContain('Queued item')
      expect(container.textContent).toContain('Running item')
      expect(container.textContent).toContain('Shipped item')
      expect(container.textContent).toContain('Rejected item')
    })

    expect(container.querySelectorAll('button[aria-label="Promote"]')).toHaveLength(1)
    expect(container.querySelectorAll('button[aria-label="Reject"]')).toHaveLength(1)
    expect(Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'undo')).toHaveLength(1)

    unmount()
  })
})
