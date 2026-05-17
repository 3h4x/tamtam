/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BudgetTab, type BudgetSettings } from '@/components/settings/BudgetTab'

const { quotaWidgetMock } = vi.hoisted(() => ({
  quotaWidgetMock: vi.fn(
    ({ providers, warnAt, blockAt }: { providers: string[]; warnAt: number; blockAt: number }) => (
      <div
        data-testid="quota-widget"
        data-providers={providers.join(',')}
        data-warn-at={String(warnAt)}
        data-block-at={String(blockAt)}
      />
    ),
  ),
}))

vi.mock('@/components/QuotaWidget', () => ({
  QuotaWidget: quotaWidgetMock,
}))

function renderBudgetTab(settings: BudgetSettings, onChange = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(BudgetTab, { settings, onChange }))
  })

  return {
    container,
    onChange,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function baseSettings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return {
    budget_block_runs_enabled: 'true',
    budget_block_on_weekly_pace_enabled: 'true',
    budget_subscription_providers: 'claude,codex',
    budget_block_at_pct: '95',
    budget_warn_at_pct: '80',
    ...overrides,
  }
}

function findCheckbox(container: HTMLElement, matcher: (labelText: string) => boolean): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((node) => matcher(node.textContent ?? ''))
  if (!(label instanceof HTMLLabelElement)) throw new Error('checkbox label not found')
  const input = label.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error('checkbox input not found')
  return input
}

function findNumberInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  if (!(label instanceof HTMLLabelElement)) throw new Error(`number input label not found: ${labelText}`)
  const wrapper = label.parentElement
  const input = wrapper?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`number input not found: ${labelText}`)
  return input
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('BudgetTab', () => {
  afterEach(() => {
    quotaWidgetMock.mockClear()
    document.body.innerHTML = ''
  })

  it('prevents deselecting the last tracked subscription provider', () => {
    const { container, onChange, unmount } = renderBudgetTab(baseSettings({
      budget_subscription_providers: 'claude',
    }))

    const quotaWidget = container.querySelector('[data-testid="quota-widget"]')
    expect(quotaWidget?.getAttribute('data-providers')).toBe('claude')

    const claudeCheckbox = findCheckbox(container, (text) => text.includes('Claude'))
    const codexCheckbox = findCheckbox(container, (text) => text.includes('Codex'))

    expect(claudeCheckbox.checked).toBe(true)
    expect(claudeCheckbox.disabled).toBe(true)
    expect(codexCheckbox.checked).toBe(false)

    claudeCheckbox.click()
    expect(onChange).not.toHaveBeenCalled()

    unmount()
  })

  it('encodes provider toggles and clamps threshold values', () => {
    const { container, onChange, unmount } = renderBudgetTab(baseSettings())

    const codexCheckbox = findCheckbox(container, (text) => text.includes('Codex'))
    codexCheckbox.click()

    expect(onChange).toHaveBeenCalledWith('budget_subscription_providers', 'claude')

    const blockInput = findNumberInput(container, 'Block threshold (%)')
    const warnInput = findNumberInput(container, 'Warn threshold (%)')

    flushSync(() => {
      setInputValue(blockInput, '150')
      setInputValue(warnInput, '-2')
    })

    expect(onChange).toHaveBeenCalledWith('budget_block_at_pct', '100')
    expect(onChange).toHaveBeenCalledWith('budget_warn_at_pct', '0')

    unmount()
  })

  it('disables only the block threshold when budget blocking is turned off', () => {
    const { container, unmount } = renderBudgetTab(baseSettings({
      budget_block_runs_enabled: 'false',
      budget_subscription_providers: 'codex',
      budget_block_at_pct: '85',
      budget_warn_at_pct: '70',
    }))

    const quotaWidget = container.querySelector('[data-testid="quota-widget"]')
    expect(quotaWidget?.getAttribute('data-providers')).toBe('codex')
    expect(quotaWidget?.getAttribute('data-warn-at')).toBe('70')
    expect(quotaWidget?.getAttribute('data-block-at')).toBe('85')

    expect(findNumberInput(container, 'Block threshold (%)').disabled).toBe(true)
    expect(findNumberInput(container, 'Warn threshold (%)').disabled).toBe(false)

    unmount()
  })
})
