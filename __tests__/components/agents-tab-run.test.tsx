/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentsTab } from '@/components/AgentsTab'

const {
  pushMock,
  replaceMock,
  toastMock,
  fetchAgentsMock,
  fetchSkillsMock,
  fetchPersonasMock,
  runAgentMock,
  searchParamsMock,
  editorPropsMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  toastMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  fetchSkillsMock: vi.fn(),
  fetchPersonasMock: vi.fn(),
  runAgentMock: vi.fn(),
  searchParamsMock: vi.fn(() => new URLSearchParams()),
  editorPropsMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => '/project/alpha/agents',
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchAgents: fetchAgentsMock,
  fetchSkills: fetchSkillsMock,
  fetchPersonas: fetchPersonasMock,
  fetchSettings: vi.fn().mockResolvedValue({ settings: {} }),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  runAgent: runAgentMock,
}))

vi.mock('@/components/agents-tab/RecommendedAgents', () => ({
  RecommendedAgents: () => null,
}))

vi.mock('@/components/agents-tab/AgentEditor', () => ({
  AgentEditor: (props: unknown) => {
    editorPropsMock(props)
    return null
  },
}))

function renderTab() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(AgentsTab, { projectName: 'alpha' }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('AgentsTab queued runs', () => {
  beforeEach(() => {
    searchParamsMock.mockReset()
    searchParamsMock.mockReturnValue(new URLSearchParams())
    editorPropsMock.mockReset()
    fetchAgentsMock.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Docs',
          project: 'alpha',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'Run docs',
          schedule: null,

          enabled: true,
        },
        {
          id: 'agent-2',
          name: 'Review',
          project: 'alpha',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'Run review',
          schedule: null,

          enabled: true,
        },
      ],
    })
    fetchSkillsMock.mockResolvedValue({ skills: [] })
    fetchPersonasMock.mockResolvedValue({ personas: [] })
    runAgentMock.mockResolvedValue({
      status: 'queued',
      code: 'pipeline_lock',
      detail: 'Agent queued behind active release',
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ settings: {} }),
    }))
  })

  afterEach(() => {
    pushMock.mockReset()
    replaceMock.mockReset()
    toastMock.mockReset()
    fetchAgentsMock.mockReset()
    fetchSkillsMock.mockReset()
    fetchPersonasMock.mockReset()
    runAgentMock.mockReset()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows a queued toast and does not navigate when the run API defers work', async () => {
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledWith('alpha')
      expect(buttonByText(container, 'Run')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Run').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(runAgentMock).toHaveBeenCalledWith('agent-1', 'Run docs')
      expect(toastMock).toHaveBeenCalledWith('Agent queued behind active release', 'success')
    })
    expect(pushMock).not.toHaveBeenCalled()

    unmount()
  })

  it('renders the richer empty state and opens the new-agent editor action', async () => {
    fetchAgentsMock.mockResolvedValueOnce({ agents: [] })
    fetchSkillsMock.mockResolvedValueOnce({
      skills: [
        { id: 'skill-1', name: 'Docs', description: '', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'skill-2', name: 'Review', description: '', content: '', createdAt: 1, updatedAt: 1 },
      ],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ settings: { agent_templates: JSON.stringify([{ name: 'Nightly' }]) } }),
    }))

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No agents yet')
      expect(container.textContent).toContain('skills available')
      expect(container.textContent).toContain('agent templates')
      expect(buttonByText(container, 'New agent')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'New agent').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/project/alpha/agents?agent=new')
    })

    unmount()
  })

  it('resolves the legacy tests template alias to the test-add recommendation', async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams('agent=new&template=tests'))

    const { unmount } = renderTab()

    await vi.waitFor(() => {
      const latestProps = editorPropsMock.mock.calls.at(-1)?.[0] as { template?: { name: string; skillIds: string[] } } | undefined
      expect(latestProps?.template).toMatchObject({
        name: 'test-add',
        skillIds: ['agent-tests'],
      })
    })

    unmount()
  })

  it('clears stale improve params when leaving the editor before a later manual agent selection', async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams('agent=agent-1&improve=1'))
    const { unmount } = renderTab()

    await vi.waitFor(() => {
      const latestProps = editorPropsMock.mock.calls.at(-1)?.[0] as { autoImprove?: boolean; onBack?: () => void } | undefined
      expect(latestProps?.autoImprove).toBe(true)
      expect(latestProps?.onBack).toBeTypeOf('function')
    })

    const firstEditorProps = editorPropsMock.mock.calls.at(-1)?.[0] as { onBack: () => void }
    firstEditorProps.onBack()

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/project/alpha/agents?agent=agent-1')
      expect(pushMock).toHaveBeenCalledWith('/project/alpha/agents')
    })

    unmount()
    editorPropsMock.mockReset()
    searchParamsMock.mockReturnValue(new URLSearchParams('agent=agent-2'))
    const second = renderTab()

    await vi.waitFor(() => {
      const latestProps = editorPropsMock.mock.calls.at(-1)?.[0] as { agent?: { id: string }; autoImprove?: boolean } | undefined
      expect(latestProps?.agent?.id).toBe('agent-2')
      expect(latestProps?.autoImprove).toBe(false)
    })

    second.unmount()
  })
})
