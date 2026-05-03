'use client'

import { useState, useEffect, useCallback } from 'react'
import { errMsg } from '@/lib/shared/types'
import { FIELDS, DEFAULTS, GRID_COLS } from '@/components/settings/constants'
import type { SettingsFieldKey } from '@/components/settings/constants'
import { SettingsField } from '@/components/settings/SettingsField'
import { AgentTemplatesTab } from '@/components/settings/AgentTemplatesTab'
export type { AgentTemplateRecord } from '@/components/settings/AgentTemplatesTab'
import { NotificationsTab } from '@/components/settings/NotificationsTab'
import type { NotificationsSettings } from '@/components/settings/NotificationsTab'
import { BudgetTab } from '@/components/settings/BudgetTab'
import type { BudgetSettings } from '@/components/settings/BudgetTab'

interface SettingsMap {
  workspace_path: string
  github_owner: string
  claude_provider: string
  claude_bin: string
  lmstudio_model: string
  log_dir: string
  frequency: string
  daytime: string
  weekends: string
  launchagent_prefix: string
  base_prompt: string
  default_model: string
  permission_mode: string
  commit_style: string
  review_verdict_rules: string
  jobs_paused: string
  fix_ci_max_retries: string
  fix_ci_retry_window_seconds: string
  fix_ci_fast_crash_ms: string
  agent_templates: string
  log_retention_count: string
  log_retention_days: string
  job_row_retention_days: string
  notification_webhook_url: string
  notification_webhook_secret: string
  notification_on_release_success: string
  notification_on_release_fail: string
  notification_on_release_aborted: string
  notification_on_fix_loop_exhausted: string
  notification_on_review_do_not_ship: string
  notification_on_agent_run_fail: string
  notification_on_budget_blocked: string
  budget_block_runs_enabled: string
  budget_subscription_providers: string
  budget_block_at_pct: string
  budget_warn_at_pct: string
  pipeline_model_review: string
  pipeline_model_fix: string
  pipeline_model_dod: string
  pipeline_model_commit: string
}

const SETTINGS_DEFAULTS: SettingsMap = {
  ...DEFAULTS,
  jobs_paused: 'false',
  notification_on_budget_blocked: 'false',
  budget_block_runs_enabled: 'false',
  budget_subscription_providers: 'claude,codex',
  budget_block_at_pct: '95',
  budget_warn_at_pct: '80',
}

type TabId = 'agent' | 'pipeline' | 'general' | 'projects' | 'database' | 'templates' | 'notifications' | 'budget'

const GROUPS: {
  id: TabId
  title: string
  description: string
  cols: number
}[] = [
  { id: 'agent',    title: 'Agent',           description: 'Which CLI backend TamTam invokes and how Claude is prompted',     cols: 2 },
  { id: 'pipeline', title: 'Release Pipeline', description: 'Commit, review, fix-loop, and retention rules for the release pipeline', cols: 2 },
  { id: 'general',  title: 'General',          description: 'Workspace location, GitHub defaults, and scheduling windows',     cols: 3 },
]

const TABS: { id: TabId; label: string }[] = [
  { id: 'agent',         label: 'Agent' },
  { id: 'pipeline',      label: 'Pipeline' },
  { id: 'general',       label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'budget',        label: 'Budget' },
  { id: 'projects',      label: 'Projects' },
  { id: 'templates',     label: 'Templates' },
  { id: 'database',      label: 'Database' },
]

interface ProjectEntry {
  name: string
  path: string
  enabled: boolean
  github: string | null
  priority: string | null
}

export function SettingsPage() {
  const [settings, setSettings]           = useState<SettingsMap>({ ...SETTINGS_DEFAULTS })
  const [savedSettings, setSavedSettings] = useState<SettingsMap>({ ...SETTINGS_DEFAULTS })
  const [loading, setLoading]             = useState(true)
  const [saving, setSaving]               = useState(false)
  const [saved, setSaved]                 = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced]   = useState(false)
  const [activeTab, setActiveTab]         = useState<TabId>(() => {
    if (typeof window === 'undefined') return 'agent'
    const stored = localStorage.getItem('tamtam-settings-tab-v2') as TabId | null
    return stored && TABS.some(t => t.id === stored) ? stored : 'agent'
  })
  const switchTab = (id: TabId) => {
    setActiveTab(id)
    try { localStorage.setItem('tamtam-settings-tab-v2', id) } catch {}
  }

  const [projects, setProjects]               = useState<ProjectEntry[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsSaving, setProjectsSaving]   = useState(false)
  const [projectsSaved, setProjectsSaved]     = useState(false)

  const isDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const loaded = { ...SETTINGS_DEFAULTS, ...data.settings }
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
    if (saving) return
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
      setSavedSettings({ ...settings })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      loadProjects()
    } catch (e: unknown) {
      setError(`Failed to save: ${errMsg(e)}`)
    } finally {
      setSaving(false)
    }
  }, [saving, settings, loadProjects])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (isDirty) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDirty, handleSave])

  const handleChange = (key: keyof SettingsMap, value: string) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'claude_provider' && (value === 'claude' || value === 'custom')) {
        // Drop stale shim paths left over from a prior shim selection
        // so the Claude CLI Path field shows the real default instead.
        if (/scripts\/(gemini|lmstudio|codex)-shim\.js$/.test(prev.claude_bin)) {
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
    setProjects((prev) => prev.map((p) => ({ ...p, enabled })))
    setProjectsSaved(false)
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
      setTimeout(() => setProjectsSaved(false), 2500)
    } catch (e: unknown) {
      setError(`Failed to save projects: ${errMsg(e)}`)
    } finally {
      setProjectsSaving(false)
    }
  }

  const [backingUp, setBackingUp]       = useState(false)
  const [backupResult, setBackupResult] = useState<{ filename: string } | null>(null)
  const [backupError, setBackupError]   = useState<string | null>(null)

  const handleBackup = async () => {
    setBackingUp(true)
    setBackupResult(null)
    setBackupError(null)
    try {
      const res  = await fetch('/api/settings/backup', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setBackupResult({ filename: data.filename })
      setTimeout(() => setBackupResult(null), 5000)
    } catch (e: unknown) {
      setBackupError(errMsg(e))
      setTimeout(() => setBackupError(null), 5000)
    } finally {
      setBackingUp(false)
    }
  }

  const enabledCount = projects.filter((p) => p.enabled).length
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isDirty && !saving && (
            <span className="text-xs text-text-tertiary">Unsaved changes · ⌘S</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className={`px-4 py-2 text-white border-none rounded-lg font-semibold text-sm transition-colors inline-flex items-center gap-1.5 ${
              saved      ? 'bg-status-success cursor-default' :
              isDirty    ? 'bg-accent hover:bg-accent-hover cursor-pointer' :
                           'bg-accent/40 cursor-default'
            } ${saving ? 'opacity-70 cursor-wait' : ''}`}
          >
            {saving && <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0" />}
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Settings'}
          </button>
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
          {error && (
            <div className="flex items-center gap-2 p-3 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error text-sm">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {error}
            </div>
          )}

          {/* Tabs */}
          <nav className="flex gap-1 border-b border-border">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                className={`px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-accent text-accent -mb-px'
                    : 'text-text-secondary hover:text-text-primary border-b-2 border-transparent -mb-px'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {GROUPS.filter((group) => group.id === activeTab).map((group) => {
            const allGroupFields = (Object.keys(FIELDS) as SettingsFieldKey[]).filter(
              (k) => FIELDS[k].group === group.id
            ).filter((k) => {
              // LM Studio replaces the semantic fast/normal/smart selector with
              // its own model identifier field — show one or the other, never both.
              if (k === 'lmstudio_model') return settings.claude_provider === 'lmstudio'
              if (k === 'default_model') return settings.claude_provider !== 'lmstudio'
              return true
            })
            const normalFields   = allGroupFields.filter((k) => !FIELDS[k].advanced)
            const advancedFields = allGroupFields.filter((k) =>  FIELDS[k].advanced)
            const gridClass      = GRID_COLS[group.cols] ?? 'grid-cols-2'

            return (
              <section key={group.id} className="bg-bg-secondary rounded-lg border border-border">
                <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
                  <h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
                  <p className="text-xs text-text-tertiary">{group.description}</p>
                </div>
                <div className="px-5 py-4">
                  <div className={`grid ${gridClass} gap-x-6 gap-y-4`}>
                    {normalFields.map((key) => (
                      <SettingsField key={key} fieldKey={key} value={settings[key]} provider={settings.claude_provider} onChange={handleChange} />
                    ))}
                  </div>

                  {advancedFields.length > 0 && (
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
                      >
                        <svg className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        Advanced
                      </button>
                      {showAdvanced && (
                        <div className={`mt-4 grid ${gridClass} gap-x-6 gap-y-4 pl-4 border-l border-border`}>
                          {advancedFields.map((key) => (
                            <SettingsField key={key} fieldKey={key} value={settings[key]} provider={settings.claude_provider} onChange={handleChange} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )
          })}

          {/* Projects */}
          {activeTab === 'projects' && settings.workspace_path && (
            <section className="bg-bg-secondary rounded-lg border border-border">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-baseline gap-3">
                  <h3 className="text-sm font-semibold text-text-primary">Projects</h3>
                  <p className="text-xs text-text-tertiary">
                    Git repositories in <code className="font-mono bg-bg-tertiary px-1 py-0.5 rounded">{settings.workspace_path}</code>
                  </p>
                  {projects.length > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent">
                      {enabledCount}/{projects.length}
                    </span>
                  )}
                </div>
                {projects.length > 0 && (
                  <div className="flex gap-1.5">
                    <button onClick={() => toggleAll(true)}
                      className="px-2.5 py-1 text-xs border border-border rounded bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors">
                      All
                    </button>
                    <button onClick={() => toggleAll(false)}
                      className="px-2.5 py-1 text-xs border border-border rounded bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors">
                      None
                    </button>
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
                  <p className="text-text-secondary text-sm py-4 text-center">
                    No git repositories found. Save your workspace path first.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
                      {projects.map((proj) => (
                        <label
                          key={proj.name}
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                            proj.enabled
                              ? 'bg-accent/8 border border-accent/20'
                              : 'border border-transparent hover:bg-bg-tertiary'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={proj.enabled}
                            onChange={() => toggleProject(proj.name)}
                            className="w-3.5 h-3.5 accent-accent rounded shrink-0"
                          />
                          <span className={`font-mono text-xs truncate ${proj.enabled ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                            {proj.name}
                          </span>
                        </label>
                      ))}
                    </div>

                    <div className="mt-3 pt-3 border-t border-border flex items-center gap-3">
                      <button
                        onClick={saveProjects}
                        disabled={projectsSaving}
                        className={`px-4 py-1.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors inline-flex items-center gap-1.5 ${
                          projectsSaved ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
                        } ${projectsSaving ? 'opacity-70 cursor-wait' : ''}`}
                      >
                        {projectsSaving && <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0" />}
                        {projectsSaving ? 'Saving…' : projectsSaved ? 'Saved!' : `Save (${enabledCount} enabled)`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {activeTab === 'projects' && !settings.workspace_path && (
            <p className="text-sm text-text-secondary bg-bg-secondary rounded-lg border border-border px-5 py-6 text-center">
              Set a workspace path in the Workspace tab first to list projects here.
            </p>
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

          {/* Budget */}
          {activeTab === 'budget' && (
            <BudgetTab
              settings={settings as unknown as BudgetSettings}
              onChange={(key, value) => handleChange(key as keyof SettingsMap, value)}
            />
          )}

          {/* Database Backup */}
          {activeTab === 'database' && (
          <section className="bg-bg-secondary rounded-lg border border-border">
            <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
              <h3 className="text-sm font-semibold text-text-primary">Database Backup</h3>
              <p className="text-xs text-text-tertiary">Create a manual backup of the SQLite database</p>
            </div>
            <div className="px-5 py-4 flex items-center gap-3">
              <button
                onClick={handleBackup}
                disabled={backingUp}
                className={`px-4 py-1.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                  backupResult ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
                } ${backingUp ? 'opacity-50 cursor-wait' : ''}`}
              >
                {backingUp ? 'Backing up…' : backupResult ? 'Done!' : 'Create Backup'}
              </button>
              {backupResult && (
                <span className="font-mono text-xs text-text-secondary">{backupResult.filename}</span>
              )}
              {backupError && (
                <span className="text-sm text-status-error">{backupError}</span>
              )}
            </div>
          </section>
          )}
        </div>
      )}
    </div>
  )
}
