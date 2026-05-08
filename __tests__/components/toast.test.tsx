/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ToastProvider, useToast } from '@/components/Toast'

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  override state = { error: null as Error | null }

  override componentDidCatch(error: Error) {
    this.setState({ error })
  }

  override render() {
    if (this.state.error) {
      return <div id="boundary-error">{this.state.error.message}</div>
    }
    return this.props.children
  }
}

function render(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(element)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function Trigger() {
  const { toast } = useToast()

  return (
    <div>
      <button id="info" onClick={() => toast('Saved draft')}>info</button>
      <button id="success" onClick={() => toast('Ship it', 'success')}>success</button>
      <button id="error" onClick={() => toast('Build failed', 'error')}>error</button>
    </div>
  )
}

function findToast(container: HTMLElement, message: string) {
  return Array.from(container.querySelectorAll('div')).find(
    (node) => node.textContent === message && node.className.includes('animate-slide-in-up'),
  )
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('throws when useToast is called outside the provider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    function BrokenConsumer() {
      useToast()
      return null
    }

    const { container, unmount } = render(
      <ErrorBoundary>
        <BrokenConsumer />
      </ErrorBoundary>,
    )

    const captured = container.querySelector('#boundary-error')
    expect(captured?.textContent).toBe('useToast must be used within ToastProvider')

    errorSpy.mockRestore()
    unmount()
  })

  it('renders info toasts and auto-dismisses them after 4 seconds', () => {
    const { container, unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    const button = container.querySelector('#info')
    if (!(button instanceof HTMLButtonElement)) throw new Error('info trigger not found')

    flushSync(() => {
      button.click()
    })

    const toast = findToast(container, 'Saved draft')
    if (!(toast instanceof HTMLDivElement)) throw new Error('info toast not found')

    expect(toast.className).toContain('bg-bg-tertiary')
    expect(toast.className).toContain('border')

    flushSync(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(container.textContent).toContain('Saved draft')

    flushSync(() => {
      vi.advanceTimersByTime(1)
    })
    expect(container.textContent).not.toContain('Saved draft')

    unmount()
  })

  it('keeps toast variants separate and removes both when their timers finish', () => {
    const { container, unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    const successButton = container.querySelector('#success')
    const errorButton = container.querySelector('#error')
    if (!(successButton instanceof HTMLButtonElement) || !(errorButton instanceof HTMLButtonElement)) {
      throw new Error('toast triggers not found')
    }

    flushSync(() => {
      successButton.click()
      errorButton.click()
    })

    const successToast = findToast(container, 'Ship it')
    const errorToast = findToast(container, 'Build failed')
    if (!(successToast instanceof HTMLDivElement) || !(errorToast instanceof HTMLDivElement)) {
      throw new Error('expected success and error toasts')
    }

    expect(successToast.className).toContain('bg-status-success')
    expect(errorToast.className).toContain('bg-status-error')

    flushSync(() => {
      vi.runAllTimers()
    })
    expect(container.textContent).not.toContain('Ship it')
    expect(container.textContent).not.toContain('Build failed')

    unmount()
  })
})
