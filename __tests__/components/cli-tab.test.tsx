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
    cli_default_model_claude: 'smart',
    cli_default_model_codex: 'normal',
    cli_default_model_gemini: 'normal',
    cli_default_model_lmstudio: 'fast',
    lmstudio_model: 'qwen2.5-coder',
    default_model: 'fast',
    permission_mode: 'bypassPermissions',
    base_prompt: '',
    budget_block_runs_enabled: 'false',
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
})
