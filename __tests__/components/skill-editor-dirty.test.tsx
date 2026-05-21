/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SkillEditor } from '@/components/skills-page/SkillEditor'
import type { Skill } from '@/lib/client-api'

function renderEditor(props: {
  skill: Skill
  onSave: (data: { name: string; description: string; content: string }) => Promise<void>
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
}): { container: HTMLElement; unmount: () => void; rerender: (next: Skill) => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  flushSync(() => {
    root.render(
      <SkillEditor
        skill={props.skill}
        onSave={props.onSave}
        onDirtyChange={props.onDirtyChange}
        onCancel={props.onCancel}
      />,
    )
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
    rerender(next: Skill) {
      flushSync(() => {
        root.render(
          <SkillEditor
            skill={next}
            onSave={props.onSave}
            onDirtyChange={props.onDirtyChange}
            onCancel={props.onCancel}
          />,
        )
      })
    },
  }
}

describe('SkillEditor dirty tracking', () => {
  const initial: Skill = { id: 'sk-1', name: 'A', description: 'desc', content: 'body', createdAt: 0, updatedAt: 0 }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clears dirty when an edit reverts to the just-saved value', async () => {
    const onSave = vi.fn(async () => {})
    const onDirtyChange = vi.fn<(dirty: boolean) => void>()

    const { container, unmount, rerender } = renderEditor({
      skill: initial,
      onSave,
      onDirtyChange,
      onCancel: () => {},
    })

    try {
      const nameInput = container.querySelector('#skill-name') as HTMLInputElement
      expect(nameInput.value).toBe('A')

      // 1. User edits A -> B. dirty must flip true.
      // React tracks input values via a hidden property; setting `.value`
      // directly is bypassed unless we go through the native setter.
      const inputProto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      flushSync(() => {
        inputProto.call(nameInput, 'B')
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(onDirtyChange).toHaveBeenLastCalledWith(true)

      // 2. User clicks Save. handleSave awaits onSave then refreshes baseline.
      const saveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith('Save')) as HTMLButtonElement
      expect(saveButton).toBeTruthy()
      flushSync(() => saveButton.click())
      // Let the awaited onSave (and the subsequent baseline refresh) resolve.
      await Promise.resolve()
      await Promise.resolve()
      expect(onSave).toHaveBeenCalledWith({ name: 'B', description: 'desc', content: 'body' })

      // Parent flow: refetched skill comes back with the saved values (same id).
      rerender({ ...initial, name: 'B' })

      // 3. User edits B -> C. Must report dirty=true.
      flushSync(() => {
        inputProto.call(nameInput, 'C')
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(onDirtyChange).toHaveBeenLastCalledWith(true)

      // 4. User reverts C -> B (the saved value). Dirty must clear back to false.
      flushSync(() => {
        inputProto.call(nameInput, 'B')
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    } finally {
      unmount()
    }
  })
})
