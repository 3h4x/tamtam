import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}))

vi.mock('@/components/project-detail/ProjectPageShell', () => ({
  ProjectPageShell: () => React.createElement('div', { 'data-testid': 'project-page-shell' }),
}))

describe('app/project/[name]/[tab]/page', () => {
  beforeEach(() => {
    notFoundMock.mockClear()
  })

  it('renders the project shell for a valid tab', async () => {
    const mod = await import('@/app/project/[name]/[tab]/page')
    const element = await mod.default({ params: Promise.resolve({ tab: 'issues' }) })

    expect(notFoundMock).not.toHaveBeenCalled()
    expect(React.isValidElement(element)).toBe(true)
    expect(element?.type).toBeDefined()
  })

  it('calls notFound for an invalid tab', async () => {
    const mod = await import('@/app/project/[name]/[tab]/page')

    await expect(mod.default({ params: Promise.resolve({ tab: 'does-not-exist' }) })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalledTimes(1)
  })
})
