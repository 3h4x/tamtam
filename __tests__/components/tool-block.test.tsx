/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ToolBlock } from '@/components/terminal/ToolBlock'

function renderToolBlock(props: React.ComponentProps<typeof ToolBlock>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ToolBlock, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('ToolBlock', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('summarizes multiline command input and toggles the result preview', () => {
    const result = 'done'.repeat(200)
    const { container, unmount } = renderToolBlock({
      tool: {
        name: 'Bash',
        input: JSON.stringify({ command: 'pnpm test\npnpm lint' }),
        result,
      },
    })

    expect(container.textContent).toContain('pnpm test pnpm lint')
    expect(container.textContent).toContain(String(result.length))
    expect(container.querySelector('pre')).toBeNull()

    const row = container.querySelector('.cursor-pointer')
    if (!(row instanceof HTMLDivElement)) throw new Error('tool row not found')
    flushSync(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const preview = container.querySelector('pre')
    expect(preview?.textContent).toBe(result.slice(0, 600) + '...')

    unmount()
  })

  it('falls back to raw input snippets and shows the executing indicator without a result', () => {
    const rawInput = 'x'.repeat(80)
    const { container, unmount } = renderToolBlock({
      tool: {
        name: 'Read',
        input: rawInput,
      },
      executing: true,
    })

    expect(container.textContent).toContain(rawInput.slice(0, 60))
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()

    expect(container.querySelector('.cursor-pointer')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()

    unmount()
  })
})
