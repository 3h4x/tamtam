/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentModal } from '@/components/agents-tab/AgentModal'

const { fetchProjectDocsMock, onSaveMock, onCloseMock } = vi.hoisted(() => ({
  fetchProjectDocsMock: vi.fn(),
  onSaveMock: vi.fn(),
  onCloseMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchProjectDocs: fetchProjectDocsMock,
}))

function renderModal(overrides: Partial<React.ComponentProps<typeof AgentModal>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const props: React.ComponentProps<typeof AgentModal> = {
    project: 'alpha',
    skills: [
      { id: 'skill-1', name: 'DB Skill', description: 'Database-backed skill', content: 'Review carefully', createdAt: 0, updatedAt: 0 },
    ],
    personas: [
      { path: 'ops.md', category: 'ops', name: 'Ops', description: 'Operator persona', emoji: '🛠️' },
    ],
    template: {
      name: 'Nightly review',
      description: 'Template',
      model: 'sonnet',
      schedule: '4h',
      runner: 'pm2',
      prompt: 'Inspect the repo',
      skillIds: ['skill-1'],
    },
    onSave: onSaveMock,
    onClose: onCloseMock,
    ...overrides,
  }

  flushSync(() => {
    root.render(<AgentModal {...props} />)
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('AgentModal', () => {
  beforeEach(() => {
    fetchProjectDocsMock.mockReset()
    onSaveMock.mockReset()
    onCloseMock.mockReset()
    fetchProjectDocsMock.mockResolvedValue({
      docs: [
        { name: 'Runbook', path: 'docs/runbook.md', content: 'Operational notes' },
      ],
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads project docs and saves selected context with normalized model values', async () => {
    const { container, unmount } = renderModal()

    await vi.waitFor(() => {
      expect(fetchProjectDocsMock).toHaveBeenCalledWith('alpha')
      expect(container.textContent).toContain('Create Agent')
    })

    buttonByText(container, 'Docs').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Runbook')
    })

    const docButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('Runbook'))
    if (!(docButton instanceof HTMLButtonElement)) throw new Error('doc button not found')
    docButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const schedule = container.querySelector('#agent-schedule')
    if (!(schedule instanceof HTMLSelectElement)) throw new Error('schedule select not found')
    setInputValue(schedule, '')

    buttonByText(container, 'Create Agent').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith({
        name: 'Nightly review',
        prompt: 'Inspect the repo',
        skillIds: ['skill-1'],
        docPaths: ['docs/runbook.md'],
        model: 'normal',
        schedule: null,
        runner: 'pm2',
        enabled: true,
        prerequisiteCommand: null,
      })
    })

    unmount()
  })

  it('shows an empty-state message when the project has no docs', async () => {
    fetchProjectDocsMock.mockResolvedValueOnce({ docs: [] })
    const { container, unmount } = renderModal()

    buttonByText(container, 'Docs').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No docs found for this project')
    })

    unmount()
  })

  it('closes when Escape is pressed', async () => {
    const { unmount } = renderModal()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    await vi.waitFor(() => {
      expect(onCloseMock).toHaveBeenCalled()
    })

    unmount()
  })
})
