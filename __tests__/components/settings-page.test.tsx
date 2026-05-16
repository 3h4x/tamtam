/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPage } from '@/components/SettingsPage'
import { TrustedGithubUsersField } from '@/components/settings/TrustedGithubUsersField'
import { SETTINGS_CHANGED_EVENT } from '@/lib/shared/settings-events'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  }
}

function renderElement(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextElement: React.ReactElement) => {
    flushSync(() => {
      root.render(nextElement)
    })
  }

  render(element)

  return {
    container,
    render,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function renderSettingsPage(initialTab: 'general' | 'pipeline' = 'pipeline') {
  return renderElement(
    React.createElement(SettingsPage as React.ComponentType<{ initialTab?: 'general' | 'pipeline' }>, { initialTab }),
  )
}

function findInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error(`Label not found: ${labelText}`)
  }
  const wrapper = label.parentElement
  const input = wrapper?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label: ${labelText}`)
  }
  return input
}

function findSelectByLabel(container: HTMLElement, labelText: string): HTMLSelectElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === labelText,
  )
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error(`Label not found: ${labelText}`)
  }
  const wrapper = label.parentElement
  const select = wrapper?.querySelector('select')
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Select not found for label: ${labelText}`)
  }
  return select
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.includes('Save Settings') || node.textContent?.includes('Saved!'),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Save button not found')
  }
  return button
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === label,
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function findInputByValue(container: HTMLElement, value: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input')).find(
    (node) => node instanceof HTMLInputElement && node.value === value,
  )
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found with value: ${value}`)
  }
  return input
}

function findTrustedGithubUsersSection(container: HTMLElement): HTMLElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent?.trim() === 'Trusted GitHub Users',
  )
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error('Trusted GitHub Users label not found')
  }
  const section = label.closest('.col-span-2')
  if (!(section instanceof HTMLElement)) {
    throw new Error('Trusted GitHub Users section not found')
  }
  return section
}

function findTrustedGithubUserInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(findTrustedGithubUsersSection(container).querySelectorAll('input')).filter(
    (node): node is HTMLInputElement => node instanceof HTMLInputElement,
  )
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
  descriptor?.set?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('SettingsPage', () => {
  beforeEach(() => {
    push.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('rehydrates canonicalized review_fix_max_iterations after save', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const input = findInputByLabel(container, 'Review Fix Loop Iterations')
    flushSync(() => {
      setInputValue(input, '03')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
        method: 'PATCH',
      }))
    })

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect((patchCall?.[1] as RequestInit).body).toContain('"review_fix_max_iterations":"03"')

    unmount()
  })

  it('saves the DO NOT SHIP policy setting from the pipeline tab', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_do_not_ship_action: 'pass',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_do_not_ship_action: 'abort',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findSelectByLabel(container, 'Do Not Ship Action').value).toBe('pass')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    flushSync(() => {
      setSelectValue(findSelectByLabel(container, 'Do Not Ship Action'), 'abort')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(findSelectByLabel(container, 'Do Not Ship Action').value).toBe('abort')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect((patchCall?.[1] as RequestInit).body).toContain('"review_do_not_ship_action":"abort"')

    unmount()
  })

  it('renders and saves legacy completion hook kill switches', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            legacy_completion_hook_release_after_run_enabled: 'true',
            legacy_completion_hook_release_after_fix_ci_enabled: 'true',
            legacy_completion_hook_auto_resume_enabled: 'true',
            legacy_pipeline_lock_inline_drain_enabled: 'true',
            legacy_completion_hook_agent_drain_enabled: 'true',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            legacy_completion_hook_release_after_run_enabled: 'false',
            legacy_completion_hook_release_after_fix_ci_enabled: 'false',
            legacy_completion_hook_auto_resume_enabled: 'false',
            legacy_pipeline_lock_inline_drain_enabled: 'false',
            legacy_completion_hook_agent_drain_enabled: 'false',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findSelectByLabel(container, 'Legacy Release-After-Run Hook').value).toBe('true')
      expect(findSelectByLabel(container, 'Legacy Release-After-Fix-CI Hook').value).toBe('true')
      expect(findSelectByLabel(container, 'Legacy Auto-Resume Hook').value).toBe('true')
      expect(findSelectByLabel(container, 'Legacy Pipeline Lock Drain').value).toBe('true')
      expect(findSelectByLabel(container, 'Legacy Agent Queue Drain Hook').value).toBe('true')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    flushSync(() => {
      setSelectValue(findSelectByLabel(container, 'Legacy Release-After-Run Hook'), 'false')
      setSelectValue(findSelectByLabel(container, 'Legacy Release-After-Fix-CI Hook'), 'false')
      setSelectValue(findSelectByLabel(container, 'Legacy Auto-Resume Hook'), 'false')
      setSelectValue(findSelectByLabel(container, 'Legacy Pipeline Lock Drain'), 'false')
      setSelectValue(findSelectByLabel(container, 'Legacy Agent Queue Drain Hook'), 'false')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(findSelectByLabel(container, 'Legacy Release-After-Run Hook').value).toBe('false')
      expect(findSelectByLabel(container, 'Legacy Release-After-Fix-CI Hook').value).toBe('false')
      expect(findSelectByLabel(container, 'Legacy Auto-Resume Hook').value).toBe('false')
      expect(findSelectByLabel(container, 'Legacy Pipeline Lock Drain').value).toBe('false')
      expect(findSelectByLabel(container, 'Legacy Agent Queue Drain Hook').value).toBe('false')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect((patchCall?.[1] as RequestInit).body).toContain('"legacy_completion_hook_release_after_run_enabled":"false"')
    expect((patchCall?.[1] as RequestInit).body).toContain('"legacy_completion_hook_release_after_fix_ci_enabled":"false"')
    expect((patchCall?.[1] as RequestInit).body).toContain('"legacy_completion_hook_auto_resume_enabled":"false"')
    expect((patchCall?.[1] as RequestInit).body).toContain('"legacy_pipeline_lock_inline_drain_enabled":"false"')
    expect((patchCall?.[1] as RequestInit).body).toContain('"legacy_completion_hook_agent_drain_enabled":"false"')

    unmount()
  })

  it('does not render the removed durable workflow setting', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            durable_agent_workflows_enabled: 'true',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage('general')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Retrieval (Embeddings)')
    })

    expect(container.textContent).not.toContain('Durable Agent Workflows')
    expect(container.textContent).not.toContain('durable_agent_workflows_enabled')
    expect(container.textContent).not.toContain('WORKFLOW_POSTGRES_URL')

    unmount()
  })

  it('round-trips retrieval settings without falling back to defaults', async () => {
    let savedBody: Record<string, string> | null = null
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            retrieval_enabled: 'false',
            retrieval_ollama_url: 'http://ollama.local:11434',
            retrieval_embedding_model: 'custom-embed',
            retrieval_context_limit: '8',
            retrieval_score_threshold: '0.65',
            retrieval_manage_ollama: 'false',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, string>
        savedBody = body
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            ...body,
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage('general')

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Ollama URL').value).toBe('http://ollama.local:11434')
      expect(findInputByLabel(container, 'Embedding Model').value).toBe('custom-embed')
      expect(findInputByLabel(container, 'Context Limit').value).toBe('8')
      expect(findInputByLabel(container, 'Score Threshold').value).toBe('0.65')
      expect(findInputByLabel(container, 'Enabled').checked).toBe(false)
      expect(getSaveButton(container).disabled).toBe(true)
    })

    flushSync(() => {
      setInputValue(findInputByLabel(container, 'Ollama URL'), 'http://ollama.internal:11434')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(savedBody).toMatchObject({
        retrieval_enabled: 'false',
        retrieval_ollama_url: 'http://ollama.internal:11434',
        retrieval_embedding_model: 'custom-embed',
        retrieval_context_limit: '8',
        retrieval_score_threshold: '0.65',
        retrieval_manage_ollama: 'false',
      })
    })

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Ollama URL').value).toBe('http://ollama.internal:11434')
      expect(findInputByLabel(container, 'Embedding Model').value).toBe('custom-embed')
      expect(findInputByLabel(container, 'Context Limit').value).toBe('8')
      expect(findInputByLabel(container, 'Score Threshold').value).toBe('0.65')
      expect(findInputByLabel(container, 'Enabled').checked).toBe(false)
      expect(getSaveButton(container).disabled).toBe(true)
    })

    unmount()
  })

  it('dispatches settings-changed with canonical settings after a successful save', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '5',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
    })

    flushSync(() => {
      setInputValue(findInputByLabel(container, 'Review Fix Loop Iterations'), '5')
    })

    await vi.waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()
    await vi.runAllTimersAsync()

    const settingsEvents = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((event): event is CustomEvent => event instanceof CustomEvent && event.type === SETTINGS_CHANGED_EVENT)

    expect(settingsEvents).toHaveLength(1)
    expect(settingsEvents[0].detail.settings).toMatchObject({
      review_fix_max_iterations: '5',
      claude_provider: 'claude',
      cli_enabled_providers: 'claude',
    })

    unmount()
  })

  it('saves and reloads trusted GitHub users through the dedicated editor', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            trusted_github_users: 'octocat',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({
          status: 'ok',
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            trusted_github_users: 'octocat, hubot',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage('general')

    await vi.waitFor(() => {
      expect(findInputByValue(container, 'octocat')).toBeTruthy()
      expect(getSaveButton(container).disabled).toBe(true)
    })

    flushSync(() => {
      findButton(container, '+ Add user').click()
    })

    await vi.waitFor(() => {
      expect(findTrustedGithubUserInputs(container)).toHaveLength(2)
      expect(findTrustedGithubUserInputs(container).some((node) => node.value === '')).toBe(true)
      expect(container.textContent).toContain('Trusted GitHub users cannot be empty.')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const emptyInput = findTrustedGithubUserInputs(container).find((node) => node.value === '')
    if (!emptyInput) throw new Error('Empty trusted user input not found')

    flushSync(() => {
      setInputValue(emptyInput, 'hubot')
    })

    await vi.waitFor(() => {
      expect(findTrustedGithubUserInputs(container).every((node) => node.value.trim().length > 0)).toBe(true)
      expect(container.textContent).not.toContain('Trusted GitHub users cannot be empty.')
      expect(getSaveButton(container).disabled).toBe(false)
    })

    getSaveButton(container).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
        method: 'PATCH',
      }))
    })

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect((patchCall?.[1] as RequestInit).body).toContain('"trusted_github_users":"octocat, hubot"')

    await vi.waitFor(() => {
      expect(findInputByValue(container, 'octocat')).toBeTruthy()
      expect(findInputByValue(container, 'hubot')).toBeTruthy()
      expect(getSaveButton(container).disabled).toBe(true)
    })

    unmount()
  })

  it('does not dispatch settings-changed when save fails', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            review_fix_max_iterations: '3',
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({ detail: 'write failed' }, false)
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const { container, unmount } = renderSettingsPage()

    await vi.waitFor(() => {
      expect(findInputByLabel(container, 'Review Fix Loop Iterations').value).toBe('3')
    })

    flushSync(() => {
      setInputValue(findInputByLabel(container, 'Review Fix Loop Iterations'), '4')
    })

    getSaveButton(container).click()
    await vi.runAllTimersAsync()

    const settingsEvents = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((event): event is CustomEvent => event instanceof CustomEvent && event.type === SETTINGS_CHANGED_EVENT)

    expect(settingsEvents).toHaveLength(0)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to save: write failed')
    })

    unmount()
  })

  it('blocks saving duplicate trusted GitHub users', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({
          settings: {
            claude_provider: 'claude',
            cli_enabled_providers: 'claude',
            trusted_github_users: 'octocat, hubot',
          },
        })
      }
      if (input === '/api/config/projects') {
        return makeResponse({ projects: [] })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderSettingsPage('general')

    await vi.waitFor(() => {
      expect(findInputByValue(container, 'octocat')).toBeTruthy()
      expect(findInputByValue(container, 'hubot')).toBeTruthy()
    })

    const secondInput = findTrustedGithubUserInputs(container).find((node) => node.value === 'hubot')
    if (!secondInput) throw new Error('Trusted GitHub user input not found: hubot')
    flushSync(() => {
      setInputValue(secondInput, 'OctoCat')
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Duplicate GitHub login: OctoCat')
      expect(getSaveButton(container).disabled).toBe(true)
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('does not echo parent-provided trusted GitHub users back through onChange', async () => {
    const onChange = vi.fn()
    const onValidityChange = vi.fn()

    const { container, render, unmount } = renderElement(
      <TrustedGithubUsersField
        value=""
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No trusted GitHub logins configured.')
    })

    onChange.mockClear()
    onValidityChange.mockClear()

    render(
      <TrustedGithubUsersField
        value="octocat"
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    )

    await vi.waitFor(() => {
      expect(findInputByValue(container, 'octocat')).toBeTruthy()
    })
    expect(onChange).not.toHaveBeenCalled()

    render(
      <TrustedGithubUsersField
        value="octocat, hubot"
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    )

    await vi.waitFor(() => {
      expect(findInputByValue(container, 'hubot')).toBeTruthy()
    })
    expect(onChange).not.toHaveBeenCalled()

    unmount()
  })
})
