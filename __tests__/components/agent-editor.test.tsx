/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentEditor } from '@/components/agents-tab/AgentEditor'

const { fetchProjectDocsMock, improveAgentPromptMock, onSaveMock, onBackMock, toastMock } = vi.hoisted(() => ({
  fetchProjectDocsMock: vi.fn(),
  improveAgentPromptMock: vi.fn(),
  onSaveMock: vi.fn(),
  onBackMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchProjectDocs: fetchProjectDocsMock,
  improveAgentPrompt: improveAgentPromptMock,
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

function renderEditor(overrides: Partial<React.ComponentProps<typeof AgentEditor>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const props: React.ComponentProps<typeof AgentEditor> = {
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

      prompt: 'Inspect the repo',
      skillIds: ['skill-1'],
    },
    onSave: onSaveMock,
    onBack: onBackMock,
    ...overrides,
  }

  flushSync(() => {
    root.render(<AgentEditor {...props} />)
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

describe('AgentEditor', () => {
  beforeEach(() => {
    fetchProjectDocsMock.mockReset()
    improveAgentPromptMock.mockReset()
    onSaveMock.mockReset()
    onBackMock.mockReset()
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
    const { container, unmount } = renderEditor()

    await vi.waitFor(() => {
      expect(fetchProjectDocsMock).toHaveBeenCalledWith('alpha')
      expect(container.textContent).toContain('Create agent')
    })

    const docsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Docs'))
    if (!(docsTab instanceof HTMLButtonElement)) throw new Error('docs tab not found')
    docsTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Runbook')
    })

    const docButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('Runbook'))
    if (!(docButton instanceof HTMLButtonElement)) throw new Error('doc button not found')
    docButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const schedule = container.querySelector('#agent-schedule')
    if (!(schedule instanceof HTMLSelectElement)) throw new Error('schedule select not found')
    setInputValue(schedule, '')

    buttonByText(container, 'Create agent').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith({
        name: 'Nightly review',
        prompt: 'Inspect the repo',
        skillIds: ['skill-1'],
        docPaths: ['docs/runbook.md'],
        model: 'normal',
        schedule: null,

        enabled: true,
        provider: null,
        fallbackEnabled: false,
        prerequisiteCommand: null,
      })
    })

    unmount()
  })

  it('shows an empty-state message when the project has no docs', async () => {
    fetchProjectDocsMock.mockResolvedValueOnce({ docs: [] })
    const { container, unmount } = renderEditor()

    const docsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Docs'))
    if (!(docsTab instanceof HTMLButtonElement)) throw new Error('docs tab not found')
    docsTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No docs found for this project')
    })

    unmount()
  })

  it('defaults the trusted-only prerequisite for issue-cruncher templates on save', async () => {
    const { container, unmount } = renderEditor({
      template: {
        name: 'issue-cruncher',
        description: 'Template',
        model: 'normal',
        schedule: '',

        prompt: '',
        skillIds: ['agent-issue-cruncher'],
      },
    })

    buttonByText(container, 'Create agent').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(expect.objectContaining({
        name: 'issue-cruncher',
        skillIds: ['agent-issue-cruncher'],
        prerequisiteCommand: 'curl -fsS "http://localhost:1337/api/projects/by-project/alpha/issues?pick_top=1"',
      }))
    })

    unmount()
  })

  it('does not re-inject the trusted-only prerequisite when editing a cleared issue-cruncher agent', async () => {
    const { container, unmount } = renderEditor({
      agent: {
        id: 'agent-1',
        name: 'issue-cruncher',
        project: 'alpha',
        skillIds: ['agent-issue-cruncher'],
        docPaths: [],
        model: 'normal',
        prompt: '',
        schedule: null,

        enabled: true,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
      },
      template: undefined,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Save changes')
    })

    buttonByText(container, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(expect.objectContaining({
        name: 'issue-cruncher',
        skillIds: ['agent-issue-cruncher'],
        prerequisiteCommand: null,
      }))
    })

    unmount()
  })

  it('replaces the prompt with the improved version when the wand is clicked', async () => {
    improveAgentPromptMock.mockResolvedValueOnce({ improvedPrompt: 'Run pnpm test --reporter=basic and report timing per file.' })
    const { container, unmount } = renderEditor()
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Inspect the repo')
    })

    const wand = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Improve'))
    if (!(wand instanceof HTMLButtonElement)) throw new Error('improve button not found')
    wand.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      const textarea = container.querySelector('#agent-prompt') as HTMLTextAreaElement | null
      expect(textarea?.value).toBe('Run pnpm test --reporter=basic and report timing per file.')
    })
    expect(improveAgentPromptMock).toHaveBeenCalledWith({
      project: 'alpha',
      draftPrompt: 'Inspect the repo',
      skillIds: ['skill-1'],
      docPaths: [],
    })
    unmount()
  })

  it('locks non-operational fields for system agents', async () => {
    const { container, unmount } = renderEditor({
      agent: {
        id: 'system:alpha:retrieval-maintenance',
        name: 'retrieval-maintenance',
        project: 'alpha',
        skillIds: ['skill-1'],
        docPaths: ['docs/runbook.md'],
        model: 'normal',
        prompt: 'Managed prompt',
        schedule: '1h',
        enabled: true,
        provider: 'codex',
        fallbackEnabled: false,
        prerequisiteCommand: null,
        kind: 'system',
        createdAt: 0,
        updatedAt: 0,
      },
      template: undefined,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Built-in system agent')
    })

    const smartButton = buttonByText(container, 'Smart')
    const codexButton = buttonByText(container, 'codex')
    const improveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Improve'))
    expect(smartButton.disabled).toBe(true)
    expect(codexButton.disabled).toBe(true)
    expect(improveButton).toBeInstanceOf(HTMLButtonElement)
    expect((improveButton as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === '×')).toBe(false)

    const systemDocsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Docs'))
    if (!(systemDocsTab instanceof HTMLButtonElement)) throw new Error('docs tab not found')
    systemDocsTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Runbook')
    })
    const runbookButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('Runbook'))
    expect(runbookButton).toBeInstanceOf(HTMLButtonElement)
    expect((runbookButton as HTMLButtonElement).disabled).toBe(true)

    const schedule = container.querySelector('#agent-schedule')
    if (!(schedule instanceof HTMLSelectElement)) throw new Error('schedule select not found')
    setInputValue(schedule, '2h')
    buttonByText(container, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith({
        name: 'retrieval-maintenance',
        prompt: 'Managed prompt',
        skillIds: ['skill-1'],
        docPaths: ['docs/runbook.md'],
        model: 'normal',
        schedule: '2h',
        enabled: true,
        provider: 'codex',
        fallbackEnabled: false,
        prerequisiteCommand: null,
      })
    })

    unmount()
  })

  it('calls onBack when Cancel button is clicked', async () => {
    const { container, unmount } = renderEditor()

    buttonByText(container, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(onBackMock).toHaveBeenCalled()
    })

    unmount()
  })
})
