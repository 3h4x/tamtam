/* @vitest-environment jsdom */

import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CliTab, type CliTabSettings } from '@/components/settings/CliTab'

function makeSettings(overrides: Partial<CliTabSettings> = {}): CliTabSettings {
  return {
    cli_enabled_providers: 'claude,lmstudio',
    cli_bin_claude: '/custom/claude',
    cli_bin_codex: '',
    cli_bin_gemini: '',
    cli_bin_lmstudio: '/custom/lmstudio',
    cli_bin_deepagents: '',
    cli_deepagents_backend: 'lmstudio',
    cli_deepagents_base_url: '',
    cli_default_model_claude: 'smart',
    cli_default_model_codex: 'normal',
    cli_default_model_gemini: 'normal',
    cli_default_model_lmstudio: 'fast',
    cli_default_model_deepagents: 'normal',
    lmstudio_model: 'qwen2.5-coder',
    default_model: 'fast',
    permission_mode: 'bypassPermissions',
    base_prompt: '',
    budget_block_runs_enabled: 'false',
    budget_block_on_weekly_pace_enabled: 'true',
    budget_block_at_pct: '95',
    budget_warn_at_pct: '80',
    ...overrides,
  }
}

function renderCliTab(settings: CliTabSettings) {
  const onChange = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(CliTab, { settings, onChange }))
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

function getCheckboxByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.includes(labelText),
  )
  const input = label?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`Checkbox not found: ${labelText}`)
  return input
}

function getInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  const wrapper = label?.parentElement
  const input = wrapper?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${labelText}`)
  return input
}

function getSelectByLabel(container: HTMLElement, labelText: string): HTMLSelectElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  const wrapper = label?.parentElement
  const select = wrapper?.querySelector('select')
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found: ${labelText}`)
  return select
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  valueSetter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('CliTab', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders per-provider bin and default-model controls for enabled providers', () => {
    const { container, unmount } = renderCliTab(makeSettings())

    expect(container.textContent).toContain('Underlying Claude executable')
    expect(container.textContent).toContain('Default model tier for Claude')
    expect(container.textContent).toContain('LM Studio model id')
    expect(container.textContent).toContain('Default model tier for LM Studio')

    unmount()
  })

  it('emits changes for provider enablement and default model controls', () => {
    const { container, onChange, unmount } = renderCliTab(makeSettings())

    const geminiToggle = Array.from(container.querySelectorAll('input'))
      .find((input) => input.type === 'checkbox' && !(input as HTMLInputElement).checked)
    geminiToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const selects = Array.from(container.querySelectorAll('select'))
    const claudeDefaultSelect = selects.find((select) => select.value === 'smart')
    claudeDefaultSelect!.value = 'normal'
    claudeDefaultSelect?.dispatchEvent(new Event('change', { bubbles: true }))

    expect(onChange).toHaveBeenCalledWith('cli_enabled_providers', 'claude,lmstudio,codex')
    expect(onChange).toHaveBeenCalledWith('cli_default_model_claude', 'normal')

    unmount()
  })

  it('keeps the last enabled CLI locked and emits provider enablement changes', () => {
    const { container, onChange, unmount } = renderCliTab(makeSettings({
      cli_enabled_providers: 'claude',
    }))

    const claude = getCheckboxByLabel(container, 'Claude')
    const codex = getCheckboxByLabel(container, 'Codex')

    expect(claude.disabled).toBe(true)
    expect(codex.disabled).toBe(false)

    codex.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onChange).toHaveBeenCalledWith('cli_enabled_providers', 'claude,codex')

    unmount()
  })

  it('disables the block threshold when the budget gate is off and emits gate changes', () => {
    const { container, onChange, unmount } = renderCliTab(makeSettings({
      budget_block_runs_enabled: 'false',
    }))

    const blockToggle = getCheckboxByLabel(container, 'Skip CLIs over budget')
    const blockThreshold = getInputByLabel(container, 'Block threshold (%)')

    expect(blockThreshold.disabled).toBe(true)

    blockToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onChange).toHaveBeenCalledWith('budget_block_runs_enabled', 'true')

    unmount()
  })

  it('clamps edited budget percentages while threshold inputs are reachable', () => {
    const { container, onChange, unmount } = renderCliTab(makeSettings({
      budget_block_runs_enabled: 'true',
    }))

    const blockThreshold = getInputByLabel(container, 'Block threshold (%)')
    const warnThreshold = getInputByLabel(container, 'Warn threshold (%)')

    expect(blockThreshold.disabled).toBe(false)

    setInputValue(blockThreshold, '150')
    setInputValue(warnThreshold, '-4')

    expect(onChange).toHaveBeenCalledWith('budget_block_at_pct', '100')
    expect(onChange).toHaveBeenCalledWith('budget_warn_at_pct', '0')

    unmount()
  })

  it('defaults the permission-mode picker to acceptEdits when the stored value is empty', () => {
    const { container, unmount } = renderCliTab(makeSettings({
      permission_mode: '',
    }))

    expect(getSelectByLabel(container, 'Permission mode').value).toBe('acceptEdits')

    unmount()
  })

  it('shows the provider-neutral auto warning copy', () => {
    const { container, unmount } = renderCliTab(makeSettings({
      permission_mode: 'auto',
    }))

    expect(container.textContent).toContain('auto preserves provider-native approval behavior')
    expect(container.textContent).toContain('Prefer acceptEdits for background runs')

    unmount()
  })
})
