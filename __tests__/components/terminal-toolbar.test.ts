/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TerminalToolbar } from '@/components/terminal/TerminalToolbar'
import type { DocItem, SkillItem } from '@/lib/terminal/terminal-session-store'
import { SETTINGS_CHANGED_EVENT } from '@/lib/shared/settings-events'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement('a', { href, ...props }, children),
}))

function buildSkill(id: string, name: string): SkillItem {
  return {
    id,
    name,
    description: `${name} description`,
    source: 'db',
  }
}

function buildDoc(name: string): DocItem {
  return {
    name,
    content: `${name} content`,
  }
}

function renderTerminalToolbar(overrides: Partial<React.ComponentProps<typeof TerminalToolbar>> = {}) {
  const onToggleSkillPicker = vi.fn()
  const onToggleDocsPicker = vi.fn()
  const onToggleItem = vi.fn()
  const onToggleDoc = vi.fn()

  const selectedItems = [buildSkill('s1', 'alpha'), buildSkill('s2', 'beta')]
  const selectedDocs = [buildDoc('runbook.md'), buildDoc('notes.md')]
  const filteredItems = [...selectedItems, buildSkill('s3', 'gamma')]
  const filteredDocs = [...selectedDocs, buildDoc('plan.md')]

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(TerminalToolbar, {
      projectName: 'owner/repo name',
      streaming: true,
      showSessions: false,
      sessions: [{ finishedAt: null, exitCode: null }],
      currentReleaseId: 'release 1',
      showThinking: true,
      selectedItems,
      selectedDocs,
      allItems: filteredItems,
      allDocs: filteredDocs,
      skillSearch: '',
      showSkillPicker: false,
      skillUsage: { s1: 2 },
      docsSearch: '',
      showDocsPicker: false,
      model: 'normal',
      provider: 'claude',
      providerLocked: false,
      permissionMode: 'auto',
      filteredItems,
      filteredDocs,
      onNewSession: vi.fn(),
      onToggleSessions: vi.fn(),
      onToggleThinking: vi.fn(),
      onToggleItem,
      onToggleDoc,
      onSkillSearchChange: vi.fn(),
      onToggleSkillPicker,
      onDocsSearchChange: vi.fn(),
      onToggleDocsPicker,
      onModelChange: vi.fn(),
      onProviderChange: vi.fn(),
      onPermissionModeChange: vi.fn(),
      ...overrides,
    }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
    onToggleSkillPicker,
    onToggleDocsPicker,
    onToggleItem,
    onToggleDoc,
    selectedItems,
    selectedDocs,
    filteredItems,
    filteredDocs,
  }
}

describe('TerminalToolbar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shows the selected counts, overflow chip, and encoded release trace link', () => {
    const { container, unmount } = renderTerminalToolbar()

    expect(container.textContent).toContain('skills')
    expect(container.textContent).toContain('docs')
    expect(container.textContent).toContain('4 attached')
    expect(container.textContent).toContain('+1')
    expect(container.textContent).toContain('live')

    const link = container.querySelector('a[href="/project/owner%2Frepo%20name/release/release%201"]')
    expect(link).toBeTruthy()
    unmount()
  })

  it('opens the controlled pickers from the toolbar buttons and overflow chip', () => {
    const { container, onToggleSkillPicker, onToggleDocsPicker, unmount } = renderTerminalToolbar()
    const buttons = Array.from(container.querySelectorAll('button'))
    const skillsButton = buttons.find(button => button.textContent?.includes('skills'))
    const docsButton = buttons.find(button => button.textContent?.includes('docs'))
    const overflowChip = buttons.find(button => button.textContent === '+1')

    skillsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    docsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    overflowChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onToggleSkillPicker).toHaveBeenCalledTimes(2)
    expect(onToggleDocsPicker).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('submits the first filtered skill and doc on Enter in the open pickers', () => {
    const { container, onToggleItem, onToggleDoc, filteredItems, filteredDocs, unmount } = renderTerminalToolbar({
      showSkillPicker: true,
      showDocsPicker: true,
    })
    const inputs = Array.from(container.querySelectorAll('input'))
    const skillInput = inputs.find(input => input.getAttribute('placeholder') === 'search skills...')
    const docsInput = inputs.find(input => input.getAttribute('placeholder') === 'search docs...')

    skillInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    docsInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onToggleItem).toHaveBeenCalledWith(filteredItems[0])
    expect(onToggleDoc).toHaveBeenCalledWith(filteredDocs[0])
    unmount()
  })

  it('calls onModelChange immediately and dispatches settings-changed after a successful model tier PATCH', async () => {
    const onModelChange = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', settings: { default_model: 'smart', jobs_paused: 'false' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const { container, unmount } = renderTerminalToolbar({ model: 'normal', onModelChange })

    const modelTrigger = Array.from(container.querySelectorAll('button[aria-haspopup="listbox"]'))
      .find(b => b.textContent?.includes('Normal'))
    flushSync(() => {
      modelTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const smartButton = Array.from(container.querySelectorAll('button[role="option"]'))
      .find(b => b.textContent?.includes('Smart'))
    smartButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onModelChange).toHaveBeenCalledWith('smart')

    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ default_model: 'smart' }),
    }))

    const settingsEvents = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((event): event is CustomEvent => event instanceof CustomEvent && event.type === SETTINGS_CHANGED_EVENT)
    expect(settingsEvents).toHaveLength(1)
    expect(settingsEvents[0].detail.settings).toMatchObject({ default_model: 'smart' })

    unmount()
  })

  it('does not dispatch settings-changed when the model tier PATCH fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const { container, unmount } = renderTerminalToolbar({ model: 'normal', onModelChange: vi.fn() })

    const modelTrigger = Array.from(container.querySelectorAll('button[aria-haspopup="listbox"]'))
      .find(b => b.textContent?.includes('Normal'))
    flushSync(() => {
      modelTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const fastButton = Array.from(container.querySelectorAll('button[role="option"]'))
      .find(b => b.textContent?.includes('Fast'))
    fastButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.runAllTimersAsync()

    const settingsEvents = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((event): event is CustomEvent => event instanceof CustomEvent && event.type === SETTINGS_CHANGED_EVENT)
    expect(settingsEvents).toHaveLength(0)

    unmount()
  })
})
