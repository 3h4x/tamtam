/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ConfigTab, normalizeActionColorForPicker } from '@/components/project-detail/ConfigTab'
import type { ProjectConfig } from '@/lib/client-api'

const baseConfig: ProjectConfig = {
  project: 'alpha',
  test_command: '',
  detected_test_command: '',
  effective_test_command: '',
  test_cron_enabled: false,
  test_cron_schedule: '',
  file_config: [],
}

function renderConfigTab(overrides: Partial<React.ComponentProps<typeof ConfigTab>> = {}) {
  const props: React.ComponentProps<typeof ConfigTab> = {
    config: baseConfig,
    configLoading: false,
    testCommandInput: '',
    setTestCommandInput: vi.fn(),
    releaseTimeoutMinutesInput: '',
    setReleaseTimeoutMinutesInput: vi.fn(),
    testCronEnabledInput: false,
    setTestCronEnabledInput: vi.fn(),
    testCronScheduleInput: '',
    setTestCronScheduleInput: vi.fn(),
    autoCommitEnabledInput: false,
    setAutoCommitEnabledInput: vi.fn(),
    autoPushEnabledInput: false,
    setAutoPushEnabledInput: vi.fn(),
    autoPrMergeEnabledInput: false,
    setAutoPrMergeEnabledInput: vi.fn(),
    postMergeWatchMinutesInput: '',
    setPostMergeWatchMinutesInput: vi.fn(),
    autoRevertEnabledInput: false,
    setAutoRevertEnabledInput: vi.fn(),
    releaseAfterRunInput: false,
    setReleaseAfterRunInput: vi.fn(),
    issueAutoBranchInput: false,
    setIssueAutoBranchInput: vi.fn(),
    testsDisabledInput: false,
    setTestsDisabledInput: vi.fn(),
    reviewDisabledInput: false,
    setReviewDisabledInput: vi.fn(),
    reviewPromptAddendumInput: '',
    setReviewPromptAddendumInput: vi.fn(),
    reviewPrerequisiteCommandInput: '',
    setReviewPrerequisiteCommandInput: vi.fn(),
    fixPromptAddendumInput: '',
    setFixPromptAddendumInput: vi.fn(),
    commitStyleInput: '',
    setCommitStyleInput: vi.fn(),
    websiteInput: '',
    setWebsiteInput: vi.fn(),
    qaUrlInput: '',
    setQaUrlInput: vi.fn(),
    editActions: [],
    setEditActions: vi.fn(),
    anyDirty: false,
    anySaving: false,
    allSaved: false,
    onSaveAll: vi.fn(),
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ConfigTab, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => {
    const text = node.textContent ?? ''
    return text.includes('Save') || text.includes('Saved') || text.includes('Saving')
  })
  if (!(button instanceof HTMLButtonElement)) throw new Error('save button not found')
  return button
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('normalizeActionColorForPicker', () => {
  it('maps legacy named colors to picker-safe hex values', () => {
    expect(normalizeActionColorForPicker('green')).toBe('#16a34a')
    expect(normalizeActionColorForPicker('blue')).toBe('#2563eb')
  })

  it('preserves hex colors and expands shorthand values', () => {
    expect(normalizeActionColorForPicker('#123456')).toBe('#123456')
    expect(normalizeActionColorForPicker('#abc')).toBe('#aabbcc')
  })

  it('falls back to the default color for empty or invalid values', () => {
    expect(normalizeActionColorForPicker('')).toBe('#2563eb')
    expect(normalizeActionColorForPicker('not-a-color')).toBe('#2563eb')
    expect(normalizeActionColorForPicker(undefined)).toBe('#2563eb')
  })
})

describe('ConfigTab save button', () => {
  it('renders the editable save state as active', () => {
    const { container, unmount } = renderConfigTab({ anyDirty: true })

    const button = getSaveButton(container)

    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Save')
    expect(button.getAttribute('class')).not.toContain('opacity-70')

    unmount()
  })

  it('renders the saved state as full-opacity disabled success', () => {
    const { container, unmount } = renderConfigTab({ allSaved: true })

    const button = getSaveButton(container)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Saved!')
    expect(button.getAttribute('class')).toContain('success')
    expect(button.getAttribute('class')).toContain('disabled:opacity-100')

    unmount()
  })

  it('keeps the saving state dimmed while disabled', () => {
    const { container, unmount } = renderConfigTab({ anyDirty: true, anySaving: true })

    const button = getSaveButton(container)
    const className = button.getAttribute('class') ?? ''

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Saving')
    expect(className).toContain('opacity-70')
    expect(className).toContain('disabled:opacity-70')
    expect(className).not.toContain('disabled:opacity-100')

    unmount()
  })
})
