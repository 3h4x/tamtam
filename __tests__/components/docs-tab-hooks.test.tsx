/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DocsTab } from '@/components/DocsTab'
import type { ProjectDoc } from '@/lib/client-api'

const { fetchProjectDocsMock } = vi.hoisted(() => ({
  fetchProjectDocsMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchProjectDocs: fetchProjectDocsMock,
}))

const mounts: Array<() => void> = []

afterEach(() => {
  mounts.splice(0).forEach((unmount) => unmount())
  fetchProjectDocsMock.mockReset()
})

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(<DocsTab projectName="acme/widgets" />)
  })
  mounts.push(() => {
    flushSync(() => root.unmount())
    container.remove()
  })
  return container
}

describe('DocsTab', () => {
  // Regression: useMemo used to live below the loading/error/empty early
  // returns, so the loaded render called one more hook than the loading
  // render and React threw #310 ("Rendered more hooks than during the
  // previous render"), tripping the page error boundary.
  it('survives the loading → loaded transition without a hooks-order error', async () => {
    const docs: ProjectDoc[] = [
      { name: 'README.md', path: 'README.md', content: 'line one\nline two\nline three' },
      { name: 'docs/API.md', path: 'docs/API.md', content: 'alpha\nbeta' },
    ]
    fetchProjectDocsMock.mockResolvedValue({ docs })

    const container = mount()
    // First render is the loading skeleton (loading === true).
    expect(container.querySelector('.skeleton')).not.toBeNull()

    // Flush the resolved fetch + the resulting state updates. Without the
    // fix this re-render adds a hook and throws React #310.
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'))
    expect(container.textContent).toContain('docs/API.md')
    expect(container.textContent).toContain('2 files')
    // Header line count for the active doc (README.md has 3 lines).
    expect(container.textContent).toContain('3 lines')
  })

  it('renders the empty state without a hooks-order error', async () => {
    fetchProjectDocsMock.mockResolvedValue({ docs: [] })

    const container = mount()
    await vi.waitFor(() => expect(container.textContent).toContain('No docs found'))
  })
})
