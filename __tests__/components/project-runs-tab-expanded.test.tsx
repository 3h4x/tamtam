/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { JobInfo } from '@/lib/client-api'

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement('a', rest, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/project/acme/history',
  useSearchParams: () => new URLSearchParams(''),
}))

const fetchJobsMock = vi.fn<() => Promise<{ jobs: JobInfo[] }>>()
const releaseProjectMock = vi.fn()
const pushProjectMock = vi.fn()

vi.mock('@/lib/client-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client-api')>()
  return {
    ...actual,
    fetchJobs: (...args: unknown[]) => fetchJobsMock(...(args as [])),
    releaseProject: (...args: unknown[]) => releaseProjectMock(...(args as [])),
    pushProject: (...args: unknown[]) => pushProjectMock(...(args as [])),
  }
})

import { ProjectRunsTab } from '@/components/ProjectRunsTab'

function job(partial: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    project: 'acme',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    finished_at: partial.started_at + 1,
    seen: true,
    ...partial,
  } as JobInfo
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(React.createElement(ProjectRunsTab, { projectName: 'acme' }))
  })
  return { container, root }
}

async function flush() {
  // Two microtask flushes: one for fetchJobs to resolve, one for the resulting setState.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ProjectRunsTab flat work-unit layout', () => {
  afterEach(() => {
    fetchJobsMock.mockReset()
    document.body.innerHTML = ''
  })

  it('renders release steps as a flat row recap instead of inline expandable children', async () => {
    const now = Date.now()
    fetchJobsMock.mockResolvedValue({
      jobs: [
        job({ id: 'release-1', kind: 'release', started_at: now, status: 'running', finished_at: undefined as unknown as number, exit_code: null }),
        job({ id: 'test-1', kind: 'test', started_at: now + 10, finished_at: now + 20, parent_job_id: 'release-1' }),
        job({ id: 'review-1', kind: 'review', started_at: now + 30, finished_at: now + 40, parent_job_id: 'test-1', verdict: 'LGTM' }),
      ],
    })

    const { container, root } = mount()
    await flush()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Release pipeline')
      expect(container.textContent).toContain('test ✓')
      expect(container.textContent).toContain('review LGTM')
    })
    expect(container.querySelector('button[aria-expanded]')).toBeNull()
    expect(container.querySelector('.bg-bg-primary\\/40')).toBeNull()

    root.unmount()
  })
})
