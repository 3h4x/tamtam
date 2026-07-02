'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { errMsg } from '@/lib/shared/types'
import { invalidateSettings } from '@/lib/client-api'
import { AgentTemplatesTab } from '@/components/settings/AgentTemplatesTab'
export type { AgentTemplateRecord } from '@/components/settings/AgentTemplatesTab'
import { NotificationsTab } from '@/components/settings/NotificationsTab'
import type { NotificationsSettings } from '@/components/settings/NotificationsTab'
import { CliTab } from '@/components/settings/CliTab'
import type { CliTabSettings } from '@/components/settings/CliTab'
import { GeneralPipelineTab } from '@/components/settings/GeneralPipelineTab'
import { DatabaseTab } from '@/components/settings/DatabaseTab'
import { AuthTab } from '@/components/settings/AuthTab'
import {
  SETTINGS_DEFAULTS,
  TABS,
  mergeLoadedSettings,
} from '@/components/settings/settings-page-config'
import type {
  SettingsMap,
  TabId,
  ProjectEntry,
} from '@/components/settings/settings-page-config'
import { dispatchSettingsChanged } from '@/lib/shared/settings-events'
import { parseEnabledProviders } from '@/lib/usage/cli-providers'
import { StandardTabs } from '@/components/ui/StandardTabs'
import { Spinner } from '@/components/ui/Spinner'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox } from '@/components/ui/Checkbox'
import { ErrorBanner } from '@/components/ErrorBanner'

export function SettingsPage({ initialTab }: { initialTab?: TabId } = {}) {
  const router = useRouter()
  const [settings, setSettings]           = useState<SettingsMap>({ ...SETTINGS_DEFAULTS })
  const [savedSettings, setSavedSettings] = useState<SettingsMap>({ ...SETTINGS_DEFAULTS })
  const [loading, setLoading]             = useState(true)
  const [saving, setSaving]               = useState(false)
  const [saved, setSaved]                 = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [trustedGithubUsersError, setTrustedGithubUsersError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced]   = useState(false)
  const activeTab: TabId = initialTab && TABS.some(t => t.id === initialTab) ? initialTab : 'general'
  const switchTab = (id: TabId) => {
    router.push(`/settings/${id}`)
  }

  const [projects, setProjects]               = useState<ProjectEntry[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsSaving, setProjectsSaving]   = useState(false)
  const [projectsSaved, setProjectsSaved]     = useState(false)

  // Key-walk + short-circuit avoids serializing the whole ~80-key settings
  // map twice on every re-render (e.g. saving/saved/error toggles).
  const isDirty = useMemo(() => {
    for (const k of Object.keys(settings) as (keyof SettingsMap)[]) {
      if (settings[k] !== savedSettings[k]) return true
    }
    return false
  }, [settings, savedSettings])
  const canSave = isDirty && !saving && !trustedGithubUsersError

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const loaded = mergeLoadedSettings(data.settings)
        setSettings(loaded)
        setSavedSettings(loaded)
        setLoading(false)
      })
      .catch((e) => {
        setError(`Failed to load settings: ${e.message}`)
        setLoading(false)
      })
  }, [])

  const loadProjects = useCallback(() => {
    setProjectsLoading(true)
    fetch('/api/config/projects')
      .then((r) => r.json())
      .then((data) => {
        setProjects(data.projects || [])
        setProjectsLoading(false)
      })
      .catch(() => setProjectsLoading(false))
  }, [])

  useEffect(() => {
    if (!loading && settings.workspace_path) loadProjects()
  }, [loading, settings.workspace_path, loadProjects])

  const handleSave = useCallback(async () => {
    if (saving || trustedGithubUsersError) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }
      const data = await res.json().catch(() => ({}))
      invalidateSettings()
      const canonical = mergeLoadedSettings(data.settings)
      setSettings(canonical)
      setSavedSettings(canonical)
      dispatchSettingsChanged({ ...canonical })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      loadProjects()
    } catch (e: unknown) {
      setError(`Failed to save: ${errMsg(e)}`)
    } finally {
      setSaving(false)
    }
  }, [saving, settings, loadProjects, trustedGithubUsersError])

  const canSaveRef = useRef(canSave)
  canSaveRef.current = canSave

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (canSaveRef.current) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave])

  const handleChange = (key: keyof SettingsMap, value: string) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'cli_enabled_providers') {
        next.claude_provider = parseEnabledProviders(value)[0] ?? 'claude'
      }
      if (key === 'claude_provider' && (value === 'claude' || value === 'custom')) {
        // Drop stale shim paths left over from a prior shim selection
        // so the Claude CLI Path field shows the real default instead.
        if (/scripts\/(gemini|lmstudio|codex|deepagents)-shim\.js$/.test(prev.claude_bin)) {
          next.claude_bin = value === 'claude' ? SETTINGS_DEFAULTS.claude_bin : ''
        }
      }
      return next
    })
    setSaved(false)
  }

  const toggleProject  = (name: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, enabled: !p.enabled } : p)))
    setProjectsSaved(false)
  }
  const toggleAll = (enabled: boolean) => {
    setProjects((prev) => prev.map((p) => (p.archived ? p : { ...p, enabled })))
    setProjectsSaved(false)
  }
  const setArchived = async (name: string, archived: boolean) => {
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || res.statusText)
      }
      setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, archived } : p)))
      dispatchSettingsChanged({ project_config_changed_at: String(Date.now()) })
    } catch (e: unknown) {
      setError(`Failed to ${archived ? 'archive' : 'unarchive'} ${name}: ${errMsg(e)}`)
    }
  }

  const saveProjects = async () => {
    setProjectsSaving(true)
    setProjectsSaved(false)
    try {
      const res = await fetch('/api/config/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setProjectsSaved(true)
      dispatchSettingsChanged({ project_config_changed_at: String(Date.now()) })
      setTimeout(() => setProjectsSaved(false), 2500)
    } catch (e: unknown) {
      setError(`Failed to save projects: ${errMsg(e)}`)
    } finally {
      setProjectsSaving(false)
    }
  }

  const activeProjects   = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) =>  p.archived)
  const enabledCount     = activeProjects.filter((p) => p.enabled).length

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isDirty && !saving && (
            <span className="text-xs text-text-tertiary">Unsaved changes · ⌘S</span>
          )}
          <Button
            onClick={handleSave}
            disabled={!canSave}
            variant={saved ? 'success-solid' : 'solid'}
            disabledCursor={saving ? 'wait' : 'default'}
            className={`px-4 py-2 rounded-lg font-semibold ${
              saved
                ? 'cursor-default hover:bg-status-success disabled:opacity-100'
                : canSave
                  ? ''
                  : saving
                    ? 'bg-accent/40 hover:bg-accent/40 cursor-wait disabled:opacity-70'
                    : 'bg-accent/40 hover:bg-accent/40 cursor-default disabled:opacity-100'
            }`}
          >
            {saving && <Spinner color="white" shrink />}
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Settings'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[
            { h: 'h-48', rows: 3 },
            { h: 'h-64', rows: 4 },
          ].map((s, i) => (
            <div key={i} className={`bg-bg-secondary rounded-lg border border-border p-5 flex flex-col gap-3 ${s.h}`}>
              <div className="skeleton h-4 w-1/3 rounded" />
              {Array.from({ length: s.rows }).map((_, j) => (
                <div key={j} className="skeleton h-3.5 rounded" style={{ width: `${85 - j * 8}%` }} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          {/* Tabs */}
          <StandardTabs
            items={TABS}
            activeTab={activeTab}
            ariaLabel="Settings navigation"
            onChange={switchTab}
          />

          <GeneralPipelineTab
            activeTab={activeTab}
            settings={settings}
            handleChange={handleChange}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            setTrustedGithubUsersError={setTrustedGithubUsersError}
          />

          {activeTab === 'auth' && (
            <AuthTab
              configured={settings.auth_token_configured === 'true'}
              onConfiguredChange={(value) => {
                setSettings((prev) => ({ ...prev, auth_token_configured: value }))
                setSavedSettings((prev) => ({ ...prev, auth_token_configured: value }))
              }}
            />
          )}

          {/* Projects */}
          {activeTab === 'projects' && settings.workspace_path && (
            <section className="bg-bg-secondary rounded-lg border border-border">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-baseline gap-3">
                  <h3 className="text-sm font-semibold text-text-primary">Projects</h3>
                  <p className="text-xs text-text-tertiary">
                    Git repositories in <code className="font-mono bg-bg-tertiary px-1 py-0.5 rounded">{settings.workspace_path}</code>
                  </p>
                  {activeProjects.length > 0 && (
                    <Pill tone="accent" size="xs" className="rounded-full border-transparent">
                      {enabledCount}/{activeProjects.length}
                    </Pill>
                  )}
                </div>
                {projects.length > 0 && (
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      surface="primary"
                      onClick={() => toggleAll(true)}
                    >
                      All
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      surface="primary"
                      onClick={() => toggleAll(false)}
                    >
                      None
                    </Button>
                  </div>
                )}
              </div>

              <div className="px-5 py-4">
                {projectsLoading ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="skeleton h-10 rounded-lg" />
                    ))}
                  </div>
                ) : projects.length === 0 ? (
                  <EmptyState
                    title="No git repositories found. Save your workspace path first."
                    paddingY="xs"
                    className="px-0"
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
                      {activeProjects.map((proj) => (
                        <div
                          key={proj.name}
                          className={`group flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                            proj.enabled
                              ? 'bg-accent/8 border border-accent/20'
                              : 'border border-transparent hover:bg-bg-tertiary'
                          }`}
                        >
                          <label className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                            <Checkbox
                              variant="native"
                              size="sm"
                              checked={proj.enabled}
                              onChange={() => toggleProject(proj.name)}
                            />
                            <span className={`font-mono text-xs truncate ${proj.enabled ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                              {proj.name}
                            </span>
                          </label>
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            onClick={() => setArchived(proj.name, true)}
                            className="text-[10px] text-text-tertiary hover:text-text-primary hover:no-underline opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Archive — hide from dashboards and scheduling"
                          >
                            Archive
                          </Button>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 pt-3 border-t border-border flex items-center gap-3">
                      <Button
                        onClick={saveProjects}
                        disabled={projectsSaving}
                        variant={projectsSaved ? 'success-solid' : 'solid'}
                        disabledCursor={projectsSaving ? 'wait' : 'not-allowed'}
                        className={`px-4 py-1.5 rounded-lg font-semibold ${
                          projectsSaved ? 'hover:bg-status-success' : ''
                        } ${projectsSaving ? 'opacity-70 cursor-wait disabled:opacity-70' : ''}`}
                      >
                        {projectsSaving && <Spinner color="white" shrink />}
                        {projectsSaving ? 'Saving…' : projectsSaved ? 'Saved!' : `Save (${enabledCount} enabled)`}
                      </Button>
                    </div>

                    {archivedProjects.length > 0 && (
                      <details className="mt-4 pt-3 border-t border-border">
                        <summary className="text-xs text-text-tertiary cursor-pointer hover:text-text-secondary select-none">
                          Archived ({archivedProjects.length})
                        </summary>
                        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
                          {archivedProjects.map((proj) => (
                            <div
                              key={proj.name}
                              className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-transparent hover:bg-bg-tertiary"
                            >
                              <span className="font-mono text-xs truncate text-text-tertiary line-through flex-1 min-w-0">
                                {proj.name}
                              </span>
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                onClick={() => setArchived(proj.name, false)}
                                className="text-[10px] text-text-secondary hover:text-text-primary hover:no-underline"
                              >
                                Unarchive
                              </Button>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {activeTab === 'projects' && !settings.workspace_path && (
            <EmptyState
              paddingY="xs"
              title={
                <span className="font-normal text-text-secondary">
                  Set a workspace path in the Workspace tab first to list projects here.
                </span>
              }
              className="bg-bg-secondary rounded-lg border border-border px-5"
            />
          )}

          {/* Agent Templates */}
          {activeTab === 'templates' && (
            <AgentTemplatesTab
              value={settings.agent_templates}
              onChange={(v) => handleChange('agent_templates', v)}
            />
          )}

          {/* Notifications */}
          {activeTab === 'notifications' && (
            <NotificationsTab
              settings={settings as unknown as NotificationsSettings}
              onChange={(key, value) => handleChange(key as keyof SettingsMap, value)}
            />
          )}

          {/* CLI (formerly Agent + Budget) */}
          {activeTab === 'cli' && (
            <CliTab
              settings={settings as unknown as CliTabSettings}
              onChange={(key, value) => handleChange(key as keyof SettingsMap, value)}
            />
          )}

          {/* Database Backup */}
          {activeTab === 'database' && (
            <DatabaseTab settings={settings} onChange={handleChange} />
          )}
        </div>
      )}
    </div>
  )
}
