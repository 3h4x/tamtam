/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SkillsPage } from '@/components/SkillsPage'

const {
  fetchSkillsMock,
  fetchPersonasMock,
  fetchProjectsMock,
  fetchAgentsMock,
  createAgentMock,
} = vi.hoisted(() => ({
  fetchSkillsMock: vi.fn(),
  fetchPersonasMock: vi.fn(),
  fetchProjectsMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
  createAgentMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchSkills: fetchSkillsMock,
  fetchPersonas: fetchPersonasMock,
  fetchProjects: fetchProjectsMock,
  fetchAgents: fetchAgentsMock,
  createAgent: createAgentMock,
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

function renderPage(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  flushSync(() => {
    root.render(<SkillsPage />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function textNode(container: HTMLElement, text: string): HTMLElement {
  const node = Array.from(container.querySelectorAll('*')).find((el) => el.textContent?.trim() === text)
  if (!(node instanceof HTMLElement)) throw new Error(`text not found: ${text}`)
  return node
}

describe('SkillsPage loading', () => {
  beforeEach(() => {
    fetchSkillsMock.mockResolvedValue({
      skills: [{
        id: 'skill-docs',
        name: 'Docs Skill',
        description: 'Writes docs',
        content: 'Write documentation.',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    fetchPersonasMock.mockRejectedValue(new Error('persona catalog unavailable'))
    fetchProjectsMock.mockResolvedValue({ tasks: [{ project: 'alpha' }] })
    fetchAgentsMock.mockResolvedValue({ agents: [] })
    createAgentMock.mockResolvedValue({ agent: { id: 'agent-1' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fetchSkillsMock.mockReset()
    fetchPersonasMock.mockReset()
    fetchProjectsMock.mockReset()
    fetchAgentsMock.mockReset()
    createAgentMock.mockReset()
    document.body.innerHTML = ''
  })

  it('keeps DB skills available when the file skill catalog fails', async () => {
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(textNode(container, 'Docs Skill')).toBeTruthy()
    })
    expect(textNode(container, 'Edit')).toBeTruthy()

    textNode(container, 'Docs Skill').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(textNode(container, '1 skill selected')).toBeTruthy()
    })

    textNode(container, 'Create Agents').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Docs Skill',
        project: 'alpha',
        skillIds: ['skill-docs'],
      }))
    })

    unmount()
  })
})
