/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentTemplatesTab } from '@/components/settings/AgentTemplatesTab'

function renderTab(value: string, onChange = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<AgentTemplatesTab value={value} onChange={onChange} />)
  })

  return {
    container,
    onChange,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim().includes(text))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

function buttonByExactText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

function inputByLabel(container: HTMLElement, labelText: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = Array.from(container.querySelectorAll('label')).find((node) => node.textContent?.trim() === labelText)
  if (!(label instanceof HTMLLabelElement)) throw new Error(`label not found: ${labelText}`)
  const wrapper = label.parentElement
  const field = wrapper?.querySelector('input, textarea, select')
  if (
    !(field instanceof HTMLInputElement)
    && !(field instanceof HTMLTextAreaElement)
    && !(field instanceof HTMLSelectElement)
  ) {
    throw new Error(`field not found for label: ${labelText}`)
  }
  return field
}

function setValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  flushSync(() => {
    const proto = field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : field instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    descriptor?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function click(button: HTMLButtonElement) {
  flushSync(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('AgentTemplatesTab', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('normalizes saved legacy model aliases when rendering existing templates', () => {
    const { container, unmount } = renderTab(JSON.stringify([
      {
        name: 'Nightly review',
        description: 'Looks at open changes',
        model: 'opus',
        schedule: '4h',
        runner: 'pm2',
        prompt: 'Review the repo',
      },
    ]))

    expect(container.textContent).toContain('Nightly review')
    expect(container.textContent).toContain('smart')
    expect(container.textContent).toContain('every 4h')

    unmount()
  })

  it('adds, edits, and deletes templates while emitting persisted JSON', async () => {
    const { container, onChange, unmount } = renderTab('')

    expect(container.textContent).toContain('No custom templates yet')

    click(buttonByText(container, '+ Add Template'))

    const addButton = buttonByExactText(container, 'Add Template')
    expect(addButton.disabled).toBe(true)

    setValue(inputByLabel(container, 'Name') as HTMLInputElement, 'Nightly review')
    setValue(inputByLabel(container, 'Description') as HTMLInputElement, 'Checks the repo overnight')
    setValue(inputByLabel(container, 'Schedule') as HTMLSelectElement, '4h')
    setValue(inputByLabel(container, 'Prompt') as HTMLTextAreaElement, 'Review recent changes')

    expect(addButton.disabled).toBe(false)

    click(addButton)

    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify([
      {
        name: 'Nightly review',
        description: 'Checks the repo overnight',
        model: 'normal',
        schedule: '4h',
        runner: 'pm2',
        prompt: 'Review recent changes',
      },
    ]))
    expect(container.textContent).toContain('Nightly review')

    click(buttonByText(container, 'Edit'))
    setValue(inputByLabel(container, 'Model') as HTMLSelectElement, 'smart')
    click(buttonByExactText(container, 'Save'))

    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify([
      {
        name: 'Nightly review',
        description: 'Checks the repo overnight',
        model: 'smart',
        schedule: '4h',
        runner: 'pm2',
        prompt: 'Review recent changes',
      },
    ]))
    expect(container.textContent).toContain('smart')

    click(buttonByText(container, 'Delete'))

    expect(onChange).toHaveBeenLastCalledWith('')
    expect(container.textContent).toContain('No custom templates yet')

    unmount()
  })
})
