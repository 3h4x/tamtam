/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsField } from '@/components/settings/SettingsField'

function renderSettingsField(overrides: Partial<React.ComponentProps<typeof SettingsField>> = {}) {
  const onChange = vi.fn()
  const props: React.ComponentProps<typeof SettingsField> = {
    fieldKey: 'claude_bin',
    value: '',
    provider: 'claude',
    onChange,
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(SettingsField, props))
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

describe('SettingsField', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows shim-managed binary paths as disabled inputs for supported providers', () => {
    const { container, onChange, unmount } = renderSettingsField({
      fieldKey: 'claude_bin',
      provider: 'codex',
      value: '/tmp/ignored',
    })

    const input = container.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('input not found')

    expect(input.disabled).toBe(true)
    expect(input.value).toBe('<TamTam>/scripts/codex-shim.js')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).not.toHaveBeenCalled()

    unmount()
  })

  it('renders provider-aware model labels for the default model selector', () => {
    const { container, unmount } = renderSettingsField({
      fieldKey: 'default_model',
      provider: 'codex',
      value: 'normal',
    })

    const select = container.querySelector('select')
    if (!(select instanceof HTMLSelectElement)) throw new Error('select not found')

    const optionLabels = Array.from(select.options).map((option) => option.textContent)
    expect(optionLabels).toContain('Fast → gpt-5.4-mini')
    expect(optionLabels).toContain('Normal → gpt-5.4')

    unmount()
  })

  it('uses the pipeline-specific default copy for pipeline model selectors', () => {
    const reviewField = renderSettingsField({
      fieldKey: 'pipeline_model_review',
      provider: 'claude',
      value: '',
    })
    const reviewSelect = reviewField.container.querySelector('select')
    if (!(reviewSelect instanceof HTMLSelectElement)) throw new Error('review select not found')
    expect(reviewSelect.options[0]?.textContent).toBe('Default (workspace)')
    reviewField.unmount()

    const fixField = renderSettingsField({
      fieldKey: 'pipeline_model_fix',
      provider: 'claude',
      value: '',
    })
    const fixSelect = fixField.container.querySelector('select')
    if (!(fixSelect instanceof HTMLSelectElement)) throw new Error('fix select not found')
    expect(fixSelect.options[0]?.textContent).toBe('Default (Smart)')
    fixField.unmount()

    const commitField = renderSettingsField({
      fieldKey: 'pipeline_model_commit',
      provider: 'claude',
      value: '',
    })
    const commitSelect = commitField.container.querySelector('select')
    if (!(commitSelect instanceof HTMLSelectElement)) throw new Error('commit select not found')
    expect(commitSelect.options[0]?.textContent).toBe('Default (Fast)')
    commitField.unmount()
  })

  it('renders the DO NOT SHIP policy selector', () => {
    const { container, onChange, unmount } = renderSettingsField({
      fieldKey: 'review_do_not_ship_action',
      provider: 'claude',
      value: 'pass',
    })

    const select = container.querySelector('select')
    if (!(select instanceof HTMLSelectElement)) throw new Error('select not found')

    expect(Array.from(select.options).map((option) => option.value)).toEqual(['pass', 'fix', 'abort'])
    expect(select.value).toBe('pass')

    select.value = 'abort'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith('review_do_not_ship_action', 'abort')

    unmount()
  })
})
