/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentGuidePage } from '@/components/AgentGuidePage'
import { ToastProvider } from '@/components/Toast'

describe('AgentGuidePage', () => {
  let container: HTMLDivElement
  let root: Root
  let writeTextMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    })
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  async function render() {
    flushSync(() => {
      root.render(
        <ToastProvider>
          <AgentGuidePage />
        </ToastProvider>,
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }

  function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
    if (!button) throw new Error(`button "${label}" not found`)
    flushSync(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('renders the guide and copies the runtime API base URL', async () => {
    await render()

    expect(container.textContent).toContain('Remote Operator Guide')
    expect(container.textContent).toContain(`${window.location.origin}/api`)
    expect(container.textContent).toContain('project=<project>')
    expect(container.textContent).toContain('agent:<agent-name>')
    expect(container.textContent).not.toContain('project=tamtam')

    clickButton('Copy URL')

    await vi.waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(`${window.location.origin}/api`)
    })
  })

  it('copies a self-contained Markdown guide with the runtime origin', async () => {
    await render()

    clickButton('Copy guide')

    await vi.waitFor(() => {
      const copied = writeTextMock.mock.calls[0]?.[0] as string | undefined
      expect(copied).toContain('# TamTam')
      expect(copied).toContain('Remote Operator Guide')
      expect(copied).toContain(`Base URL: ${window.location.origin}/api`)
      expect(copied).toContain('## API reference')
      expect(copied).toContain('project=<project>')
      expect(copied).toContain('"project": "<project>"')
      expect(copied).toContain('agent:<agent-name>')
      expect(copied).not.toContain('project=tamtam')
      expect(copied).not.toContain('"project":"tamtam"')
      expect(copied).not.toContain('"project": "tamtam"')
    })
  })
})
