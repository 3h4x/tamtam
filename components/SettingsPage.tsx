'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { errMsg } from '@/lib/shared/types'
import { FIELDS, DEFAULTS, GRID_COLS } from '@/components/settings/constants'
import type { SettingsFieldKey } from '@/components/settings/constants'
import { SettingsField } from '@/components/settings/SettingsField'
import { AgentTemplatesTab } from '@/components/settings/AgentTemplatesTab'
export type { AgentTemplateRecord } from '@/components/settings/AgentTemplatesTab'
import { NotificationsTab } from '@/components/settings/NotificationsTab'
import type { NotificationsSettings } from '@/components/settings/NotificationsTab'
import { CliTab } from '@/components/settings/CliTab'
import type { CliTabSettings } from '@/components/settings/CliTab'
import { TrustedGithubUsersField } from '@/components/settings/TrustedGithubUsersField'
import { dispatchSettingsChanged } from '@/lib/shared/settings-events'
import { parseEnabledProviders } from '@/lib/usage/cli-providers'

interface SettingsMap {
  workspace_path: string
  github_owner: string
  trusted_github_users: string
  github_board_sync_enabled: string
  github_board_project_owner: string
  github_board_project_title: string
  github_board_project_number: string
  github_board_project_url: string
  github_board_view_url: string
  claude_provider: string
  claude_bin: string
  cli_enabled_providers: string
  cli_bin_claude: string
  cli_bin_codex: string
  cli_bin_gemini: string
  cli_bin_lmstudio: string
  cli_default_model_claude: string
  cli_default_model_codex: string
  cli_default_model_gemini: string
  cli_default_model_lmstudio: string
  lmstudio_model: string
  log_dir: string
  frequency: string
  daytime: string
  weekends: string
  base_prompt: string
  default_model: string
  permission_mode: string
  commit_style: string
  review_verdict_rules: string
  jobs_paused: string
  review_fix_max_iterations: string
  review_do_not_ship_action: string
  release_wall_clock_timeout_minutes: string
  legacy_completion_hook_release_after_run_enabled: string
  legacy_completion_hook_release_after_fix_ci_enabled: string
  legacy_completion_hook_auto_resume_enabled: string
  legacy_pipeline_lock_inline_drain_enabled: string
  agent_templates: string
  log_retention_count: string
  log_retention_days: string
  job_row_retention_days: string
  workflow_run_retention_days: string
  backup_retention_count: string
  backup_retention_weekly_count: string
  notification_webhook_url: string
  notification_webhook_secret: string
  notification_on_release_success: string
  notification_on_release_fail: string
  notification_on_release_aborted: string
  notification_on_fix_loop_exhausted: string
  notification_on_review_do_not_ship: string
  notification_on_agent_run_fail: string
  notification_on_budget_blocked: string
  notification_throttle_window_seconds: string
  notification_throttle_overrides: string
  budget_block_runs_enabled: string
  budget_subscription_providers: string
  budget_block_at_pct: string
  budget_warn_at_pct: string
  pipeline_model_review: string
  pipeline_model_fix: string
  pipeline_model_dod: string
  pipeline_model_commit: string
  project_sweep_enabled: string
  dirty_worktree_block_threshold: string
  incremental_review_enabled: string
  retrieval_enabled: string
  retrieval_ollama_url: string
  retrieval_embedding_model: string
  retrieval_context_limit: string
  retrieval_score_threshold: string
  retrieval_manage_ollama: string
}

const SETTINGS_DEFAULTS: SettingsMap = {
  ...DEFAULTS,
  github_board_sync_enabled: 'false',
  github_board_project_owner: '',
  github_board_project_title: 'TamTam',
  github_board_project_number: '',
  github_board_project_url: '',
  github_board_view_url: '',
  cli_enabled_providers: 'claude',
  cli_bin_claude: '',
  cli_bin_codex: '',
  cli_bin_gemini: '',
  cli_bin_lmstudio: '',
  cli_default_model_claude: 'normal',
  cli_default_model_codex: 'normal',
  cli_default_model_gemini: 'normal',
  cli_default_model_lmstudio: 'normal',
  jobs_paused: 'false',
  notification_on_budget_blocked: 'false',
  notification_throttle_window_seconds: '900',
  notification_throttle_overrides: '{"release_fail":0,"release_aborted":0}',
  budget_block_runs_enabled: 'false',
  budget_subscription_providers: 'claude,codex',
  budget_block_at_pct: '95',
  budget_warn_at_pct: '80',
  retrieval_enabled: 'true',
  retrieval_ollama_url: 'http://localhost:11434',
  retrieval_embedding_model: 'nomic-embed-text',
  retrieval_context_limit: '5',
  retrieval_score_threshold: '0.8',
  retrieval_manage_ollama: 'true',
}

type TabId = 'general' | 'cli' | 'pipeline' | 'projects' | 'database' | 'templates' | 'notifications'

const GROUPS: {
  id: TabId
  title: string
  description: string
  cols: number
}[] = [
  { id: 'pipeline', title: 'Release Pipeline', description: 'Commit, review, fix-loop, and retention rules for the release pipeline', cols: 2 },
  { id: 'general',  title: 'General',          description: 'Workspace location, GitHub defaults, trust allowlists, and scheduling windows', cols: 3 },
]

const TABS: { id: TabId; label: string }[] = [
  { id: 'general',       label: 'General' },
  { id: 'cli',           label: 'CLI' },
  { id: 'pipeline',      label: 'Pipeline' },
  { id: 'notifications', label: 'Notifications' },
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
  archived: boolean
}

function mergeLoadedSettings(settings: Partial<SettingsMap> | undefined): SettingsMap {
  return { ...SETTINGS_DEFAULTS, ...(settings ?? {}) }
}

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
  const [boardResyncing, setBoardResyncing]   = useState(false)
  const [boardResyncMsg, setBoardResyncMsg]   = useState<string | null>(null)

  const isDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings)
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (canSave) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canSave, handleSave])

  const handleChange = (key: keyof SettingsMap, value: string) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'cli_enabled_providers') {
        next.claude_provider = parseEnabledProviders(value)[0] ?? 'claude'
      }
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
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={`px-4 py-2 text-white border-none rounded-lg font-semibold text-sm transition-colors inline-flex items-center gap-1.5 ${
              saved      ? 'bg-status-success cursor-default' :
              canSave ? 'bg-accent hover:bg-accent-hover cursor-pointer' :
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
              if (k === 'trusted_github_users') return false
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

                  {group.id === 'general' && (
                    <div className="mt-4">
                      <TrustedGithubUsersField
                        value={settings.trusted_github_users}
                        onChange={(value) => handleChange('trusted_github_users', value)}
                        onValidityChange={setTrustedGithubUsersError}
                      />
                    </div>
                  )}

                  {group.id === 'general' && (
                    <div className="mt-4 rounded-xl border border-border bg-bg-primary/50 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-semibold text-text-primary">Retrieval (Embeddings)</h4>
                          <p className="mt-1 text-xs text-text-tertiary">
                            Index project docs, skills, and config into pgvector via local Ollama embeddings, and inject the top-matching chunks into agent prompts. Reindex per project from the project&apos;s Config tab.
                          </p>
                        </div>
                        <label className="inline-flex items-center gap-2 text-sm text-text-primary shrink-0">
                          <input
                            type="checkbox"
                            checked={settings.retrieval_enabled === 'true'}
                            onChange={(e) => handleChange('retrieval_enabled', e.target.checked ? 'true' : 'false')}
                            className="h-4 w-4 rounded border-border bg-bg-primary text-accent focus:ring-accent/30"
                          />
                          Enabled
                        </label>
                      </div>
                      <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Ollama URL</label>
                          <input
                            value={settings.retrieval_ollama_url}
                            onChange={(e) => handleChange('retrieval_ollama_url', e.target.value)}
                            placeholder="http://localhost:11434"
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Embedding Model</label>
                          <input
                            value={settings.retrieval_embedding_model}
                            onChange={(e) => handleChange('retrieval_embedding_model', e.target.value)}
                            placeholder="nomic-embed-text"
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Context Limit</label>
                          <input
                            type="number"
                            min={1}
                            value={settings.retrieval_context_limit}
                            onChange={(e) => handleChange('retrieval_context_limit', e.target.value)}
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                          <p className="mt-1 text-xs text-text-tertiary">Top-K chunks injected per prompt.</p>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Score Threshold</label>
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={settings.retrieval_score_threshold}
                            onChange={(e) => handleChange('retrieval_score_threshold', e.target.value)}
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                          <p className="mt-1 text-xs text-text-tertiary">0–1 cosine similarity cutoff.</p>
                        </div>
                      </div>
                      <label className="mt-4 inline-flex items-center gap-2 text-sm text-text-primary">
                        <input
                          type="checkbox"
                          checked={settings.retrieval_manage_ollama === 'true'}
                          onChange={(e) => handleChange('retrieval_manage_ollama', e.target.checked ? 'true' : 'false')}
                          className="h-4 w-4 rounded border-border bg-bg-primary text-accent focus:ring-accent/30"
                        />
                        Auto-start Ollama if not running
                      </label>
                    </div>
                  )}

                  {group.id === 'general' && (
                    <div className="mt-6 rounded-xl border border-border bg-bg-primary/50 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-semibold text-text-primary">GitHub Board Sync</h4>
                          <p className="mt-1 text-xs text-text-tertiary">
                            Creates or reuses a global GitHub Project named <code className="font-mono">TamTam</code> and mirrors run lifecycle there.
                          </p>
                        </div>
                        <label className="inline-flex items-center gap-2 text-sm text-text-primary">
                          <input
                            type="checkbox"
                            checked={settings.github_board_sync_enabled === 'true'}
                            onChange={(e) => handleChange('github_board_sync_enabled', e.target.checked ? 'true' : 'false')}
                            className="h-4 w-4 rounded border-border bg-bg-primary text-accent focus:ring-accent/30"
                          />
                          Enabled
                        </label>
                      </div>
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Project Owner</label>
                          <input
                            value={settings.github_board_project_owner}
                            onChange={(e) => handleChange('github_board_project_owner', e.target.value)}
                            placeholder={settings.github_owner || 'octocat'}
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Project Title</label>
                          <input
                            value={settings.github_board_project_title}
                            onChange={(e) => handleChange('github_board_project_title', e.target.value)}
                            className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary">Project Number</label>
                          <input
                            value={settings.github_board_project_number}
                            readOnly
                            className="w-full h-10 px-3 py-2 bg-bg-tertiary text-text-secondary border border-border rounded-lg text-sm font-mono"
                          />
                        </div>
                      </div>
                      {settings.github_board_project_url && (
                        <div className="mt-3 flex items-center gap-3">
                          <a
                            href={settings.github_board_view_url || settings.github_board_project_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                          >
                            Open board on GitHub ↗
                          </a>
                          {settings.github_board_view_url && (
                            <span className="text-xs text-text-tertiary">(custom view configured)</span>
                          )}
                          <button
                            type="button"
                            disabled={boardResyncing || settings.github_board_sync_enabled !== 'true'}
                            onClick={async () => {
                              setBoardResyncing(true)
                              setBoardResyncMsg(null)
                              try {
                                const res = await fetch('/api/settings/board-resync', { method: 'POST' })
                                const data = await res.json()
                                if (!res.ok || !data.ok) {
                                  setBoardResyncMsg(data.error || `HTTP ${res.status}`)
                                } else {
                                  const rl = data.rateLimited ? ', rate-limited — wait 5 min and retry' : ''
                                  setBoardResyncMsg(`Resynced ${data.resynced}/${data.scanned} (last ${data.days}d, top ${data.limit}, ${data.failed} failed${rl})`)
                                }
                              } catch (e: unknown) {
                                setBoardResyncMsg(`Failed: ${errMsg(e)}`)
                              } finally {
                                setBoardResyncing(false)
                              }
                            }}
                            className="text-xs text-text-secondary hover:text-text-primary border border-border rounded px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {boardResyncing ? 'Resyncing…' : 'Resync recent runs'}
                          </button>
                          {boardResyncMsg && <span className="text-xs text-text-tertiary">{boardResyncMsg}</span>}
                        </div>
                      )}
                      <div className="mt-4">
                        <label className="mb-1 block text-xs font-medium text-text-secondary">Kanban view URL <span className="text-text-tertiary">(optional)</span></label>
                        <input
                          value={settings.github_board_view_url}
                          onChange={(e) => handleChange('github_board_view_url', e.target.value)}
                          placeholder="https://github.com/users/.../projects/7/views/2"
                          className="w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
                        />
                      </div>
                      {settings.github_board_project_url && (
                        <div className="mt-4 rounded-lg border border-border bg-bg-secondary/50 p-3 text-xs text-text-secondary">
                          <div className="font-semibold text-text-primary mb-1">Optional: pin a custom kanban view</div>
                          <p className="text-text-tertiary mb-2">
                            TamTam writes to the project&apos;s built-in <code className="font-mono">Status</code> field and adds <code className="font-mono">Review</code>, <code className="font-mono">Fixing</code>, and <code className="font-mono">Blocked</code> on top of GitHub&apos;s default <code className="font-mono">Todo / In Progress / Done</code>. The default <code className="font-mono">View 1</code> already groups by Status — no setup needed. To deep-link to a custom view from TamTam, create one and paste its URL above.
                          </p>
                          <ol className="list-decimal list-inside space-y-0.5 text-text-tertiary">
                            <li>Open the board (link above) and click <span className="font-mono text-text-secondary">+ New view</span></li>
                            <li>Pick <span className="font-mono text-text-secondary">Board</span> and group by <span className="font-mono text-text-secondary">Status</span></li>
                            <li>Save, then copy the new view URL into the field above so all <span className="font-mono text-text-secondary">Board ↗</span> chips deep-link to it</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  )}

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
                  {activeProjects.length > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent">
                      {enabledCount}/{activeProjects.length}
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
                          <button
                            type="button"
                            onClick={() => setArchived(proj.name, true)}
                            className="text-[10px] text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Archive — hide from dashboards and scheduling"
                          >
                            Archive
                          </button>
                        </div>
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
                              <button
                                type="button"
                                onClick={() => setArchived(proj.name, false)}
                                className="text-[10px] text-text-secondary hover:text-text-primary"
                              >
                                Unarchive
                              </button>
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

          {/* CLI (formerly Agent + Budget) */}
          {activeTab === 'cli' && (
            <CliTab
              settings={settings as unknown as CliTabSettings}
              onChange={(key, value) => handleChange(key as keyof SettingsMap, value)}
            />
          )}

          {/* Database Backup */}
          {activeTab === 'database' && (
          <section className="bg-bg-secondary rounded-lg border border-border">
            <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
              <h3 className="text-sm font-semibold text-text-primary">Database Backup</h3>
              <p className="text-xs text-text-tertiary">Create a manual backup of the Postgres database</p>
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
