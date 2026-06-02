'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { errMsg } from '@/lib/shared/types'
import { FIELDS, DEFAULTS, GRID_COLS, SUBSECTIONS } from '@/components/settings/constants'
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
import { StandardTabs } from '@/components/ui/StandardTabs'
import { Spinner } from '@/components/ui/Spinner'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { Select } from '@/components/ui/Select'
import { ErrorBanner } from '@/components/ErrorBanner'

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
  cli_bin_deepagents: string
  cli_deepagents_backend: string
  cli_deepagents_base_url: string
  cli_default_model_claude: string
  cli_default_model_codex: string
  cli_default_model_gemini: string
  cli_default_model_lmstudio: string
  cli_default_model_deepagents: string
  provider_fallback_chain: string
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
  rebuild_in_progress: string
  fix_max_iterations: string
  review_fix_backoff_seconds: string
  review_do_not_ship_action: string
  release_wall_clock_timeout_minutes: string
  legacy_completion_hook_release_after_run_enabled: string
  legacy_completion_hook_release_after_fix_ci_enabled: string
  legacy_completion_hook_auto_resume_enabled: string
  legacy_pipeline_lock_inline_drain_enabled: string
  legacy_completion_hook_agent_drain_enabled: string
  plain_test_phase_enabled: string
  agent_templates: string
  log_retention_count: string
  log_retention_days: string
  job_row_retention_days: string
  workflow_run_retention_days: string
  backup_retention_count: string
  backup_retention_weekly_count: string
  db_backup_enabled: string
  db_backup_interval_minutes: string
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
  budget_block_on_weekly_pace_enabled: string
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
  retrieval_reindex_interval_hours: string
  browser_broker_enabled: string
  browser_broker_image: string
  tamtam_network_policy_strict: string
  orchestrator_enabled: string
  orchestrator_boost_margin_pct: string
  orchestrator_max_boosts_per_hour: string
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
  cli_bin_deepagents: '',
  cli_deepagents_backend: 'lmstudio',
  cli_deepagents_base_url: '',
  cli_default_model_claude: 'normal',
  cli_default_model_codex: 'normal',
  cli_default_model_gemini: 'normal',
  cli_default_model_lmstudio: 'normal',
  cli_default_model_deepagents: 'normal',
  provider_fallback_chain: '',
  jobs_paused: 'false',
  rebuild_in_progress: 'false',
  notification_on_budget_blocked: 'false',
  notification_throttle_window_seconds: '900',
  notification_throttle_overrides: '{"release_fail":0,"release_aborted":0}',
  db_backup_enabled: 'true',
  db_backup_interval_minutes: '15',
  budget_block_runs_enabled: 'false',
  budget_block_on_weekly_pace_enabled: 'true',
  budget_subscription_providers: 'claude,codex',
  budget_block_at_pct: '95',
  budget_warn_at_pct: '80',
  retrieval_enabled: 'true',
  retrieval_ollama_url: 'http://localhost:11434',
  retrieval_embedding_model: 'nomic-embed-text',
  retrieval_context_limit: '5',
  retrieval_score_threshold: '0.8',
  retrieval_manage_ollama: 'true',
  retrieval_reindex_interval_hours: '16',
  browser_broker_enabled: 'false',
  browser_broker_image: 'mcr.microsoft.com/playwright/mcp:v0.0.30',
  tamtam_network_policy_strict: 'false',
  orchestrator_enabled: 'false',
  orchestrator_boost_margin_pct: '5',
  orchestrator_max_boosts_per_hour: '2',
}

type TabId = 'general' | 'cli' | 'pipeline' | 'projects' | 'database' | 'templates' | 'notifications'

type TabLayoutEntry =
  | { kind: 'subsection'; id: string }
  | { kind: 'inline'; id: 'trusted' | 'retrieval' | 'github_board' }

// Ordered list of cards rendered inside General / Pipeline tabs. Other tabs
// have their own dedicated components and bypass this layout.
const TAB_LAYOUT: Partial<Record<TabId, TabLayoutEntry[]>> = {
  general: [
    { kind: 'subsection', id: 'workspace' },
    { kind: 'subsection', id: 'scheduling' },
    { kind: 'inline', id: 'trusted' },
    { kind: 'subsection', id: 'base_prompt' },
    { kind: 'subsection', id: 'browser_broker' },
    { kind: 'inline', id: 'retrieval' },
    { kind: 'inline', id: 'github_board' },
  ],
  pipeline: [
    { kind: 'subsection', id: 'review' },
    { kind: 'subsection', id: 'commit' },
    { kind: 'subsection', id: 'pipeline_models' },
    { kind: 'subsection', id: 'release_ops' },
    { kind: 'subsection', id: 'orchestrator' },
    { kind: 'subsection', id: 'retention' },
    { kind: 'subsection', id: 'legacy' },
  ],
}

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

  function renderTabBody() {
    const layout = TAB_LAYOUT[activeTab]
    if (!layout) return null

    // Build a per-subsection field list from FIELDS by subsection id.
    // Provider-conditional fields (lmstudio_model / default_model) are
    // not in general/pipeline subsections today, so no filtering needed —
    // CliTab handles them.
    const fieldsBySubsection = new Map<string, SettingsFieldKey[]>()
    for (const key of Object.keys(FIELDS) as SettingsFieldKey[]) {
      const sub = FIELDS[key].subsection
      if (!sub) continue
      const arr = fieldsBySubsection.get(sub) ?? []
      arr.push(key)
      fieldsBySubsection.set(sub, arr)
    }

    // Tab-level Advanced toggle: surfaces fields with `advanced: true` and
    // subsections whose entire card is gated on advanced (e.g. legacy).
    const tabHasAdvanced = layout.some((e) => {
      if (e.kind !== 'subsection') return false
      const sub = SUBSECTIONS[e.id]
      if (sub?.advanced) return true
      const fields = fieldsBySubsection.get(e.id) ?? []
      return fields.some((k) => FIELDS[k].advanced)
    })

    function renderSubsection(subId: string) {
      const sub = SUBSECTIONS[subId]
      if (!sub) return null
      if (sub.advanced && !showAdvanced) return null
      const fields = (fieldsBySubsection.get(subId) ?? [])
        .filter((k) => !FIELDS[k].advanced || showAdvanced)
      if (fields.length === 0) return null
      const cols = sub.cols ?? 2
      const gridClass = GRID_COLS[cols] ?? 'grid-cols-2'
      const body = (
        <div className={`grid ${gridClass} gap-x-6 gap-y-4`}>
          {fields.map((key) => (
            <SettingsField key={key} fieldKey={key} value={settings[key]} provider={settings.claude_provider} onChange={handleChange} />
          ))}
        </div>
      )
      const header = (
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">{sub.title}</h3>
          {sub.description && <p className="text-xs text-text-tertiary">{sub.description}</p>}
        </div>
      )
      return (
        <section key={`sub:${subId}`} className="bg-bg-secondary rounded-lg border border-border">
          {sub.defaultCollapsed ? (
            <details>
              <summary className="px-5 py-3 border-b border-border cursor-pointer list-none flex items-baseline gap-3 group">
                <svg className="w-3 h-3 transition-transform group-open:rotate-90 text-text-tertiary"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {header}
              </summary>
              <div className="px-5 py-4">{body}</div>
            </details>
          ) : (
            <>
              <div className="px-5 py-3 border-b border-border">{header}</div>
              <div className="px-5 py-4">{body}</div>
            </>
          )}
        </section>
      )
    }

    function renderTrustedUsers() {
      return (
        <section key="inline:trusted" className="bg-bg-secondary rounded-lg border border-border">
          <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Trusted GitHub Users</h3>
            <p className="text-xs text-text-tertiary">Workspace allowlist for issue/PR authors whose GitHub content TamTam treats as trusted.</p>
          </div>
          <div className="px-5 py-4">
            <TrustedGithubUsersField
              value={settings.trusted_github_users}
              onChange={(value) => handleChange('trusted_github_users', value)}
              onValidityChange={setTrustedGithubUsersError}
            />
          </div>
        </section>
      )
    }

    function renderRetrieval() {
      return (
        <section key="inline:retrieval" className="bg-bg-secondary rounded-lg border border-border">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-3 min-w-0">
              <h3 className="text-sm font-semibold text-text-primary shrink-0">Retrieval (Embeddings)</h3>
              <p className="text-xs text-text-tertiary truncate">Indexes project docs, skills, and config into pgvector via Ollama; injects top-matching chunks into agent prompts.</p>
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-text-primary shrink-0">
              <Checkbox
                checked={settings.retrieval_enabled === 'true'}
                onChange={(e) => handleChange('retrieval_enabled', e.target.checked ? 'true' : 'false')}
              />
              Enabled
            </label>
          </div>
          <div className="px-5 py-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Ollama URL</label>
                <Input
                  value={settings.retrieval_ollama_url}
                  onChange={(e) => handleChange('retrieval_ollama_url', e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Embedding Model</label>
                <Input
                  value={settings.retrieval_embedding_model}
                  onChange={(e) => handleChange('retrieval_embedding_model', e.target.value)}
                  placeholder="nomic-embed-text"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Context Limit</label>
                <Input
                  type="number"
                  min={1}
                  value={settings.retrieval_context_limit}
                  onChange={(e) => handleChange('retrieval_context_limit', e.target.value)}
                />
                <p className="mt-1 text-xs text-text-tertiary">Top-K chunks per prompt.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Score Threshold</label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.retrieval_score_threshold}
                  onChange={(e) => handleChange('retrieval_score_threshold', e.target.value)}
                />
                <p className="mt-1 text-xs text-text-tertiary">0–1 cosine cutoff.</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-6 flex-wrap">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Reindex Interval (hours)</label>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={settings.retrieval_reindex_interval_hours}
                  onChange={(e) => handleChange('retrieval_reindex_interval_hours', e.target.value)}
                  fullWidth={false}
                  className="w-32"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-sm text-text-primary">
                <Checkbox
                  checked={settings.retrieval_manage_ollama === 'true'}
                  onChange={(e) => handleChange('retrieval_manage_ollama', e.target.checked ? 'true' : 'false')}
                />
                Auto-start Ollama if not running
              </label>
            </div>
          </div>
        </section>
      )
    }

    function renderGithubBoard() {
      return (
        <section key="inline:github_board" className="bg-bg-secondary rounded-lg border border-border">
          <details>
            <summary className="px-5 py-3 border-b border-border cursor-pointer list-none flex items-center justify-between gap-4 group">
              <div className="flex items-baseline gap-3 min-w-0">
                <svg className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90 text-text-tertiary"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <h3 className="text-sm font-semibold text-text-primary">GitHub Board Sync</h3>
                <p className="text-xs text-text-tertiary truncate">
                  Mirrors run lifecycle to a global GitHub Project named <code className="font-mono">TamTam</code>.
                </p>
              </div>
              <label
                className="inline-flex items-center gap-2 text-sm text-text-primary shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={settings.github_board_sync_enabled === 'true'}
                  onChange={(e) => handleChange('github_board_sync_enabled', e.target.checked ? 'true' : 'false')}
                />
                Enabled
              </label>
            </summary>
            <div className="px-5 py-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">Project Owner</label>
                  <Input
                    value={settings.github_board_project_owner}
                    onChange={(e) => handleChange('github_board_project_owner', e.target.value)}
                    placeholder={settings.github_owner || 'octocat'}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">Project Title</label>
                  <Input
                    value={settings.github_board_project_title}
                    onChange={(e) => handleChange('github_board_project_title', e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">Project Number</label>
                  <Input
                    value={settings.github_board_project_number}
                    readOnly
                    appearance="muted"
                  />
                </div>
              </div>
              {settings.github_board_project_url && (
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <a
                    href={settings.github_board_view_url || settings.github_board_project_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({
                      variant: 'link',
                      size: 'sm',
                      className: 'inline-flex items-center gap-1',
                    })}
                  >
                    Open board on GitHub ↗
                  </a>
                  {settings.github_board_view_url && (
                    <span className="text-xs text-text-tertiary">(custom view configured)</span>
                  )}
                  <Button
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
                    size="sm"
                    variant="ghost"
                    className="border-border"
                  >
                    {boardResyncing ? 'Resyncing…' : 'Resync recent runs'}
                  </Button>
                  {boardResyncMsg && <span className="text-xs text-text-tertiary">{boardResyncMsg}</span>}
                </div>
              )}
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-text-secondary">Kanban view URL <span className="text-text-tertiary">(optional)</span></label>
                <Input
                  value={settings.github_board_view_url}
                  onChange={(e) => handleChange('github_board_view_url', e.target.value)}
                  placeholder="https://github.com/users/.../projects/7/views/2"
                />
              </div>
            </div>
          </details>
        </section>
      )
    }

    return (
      <>
        {tabHasAdvanced && (
          <div className="flex justify-end">
            <label className="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer">
              <Checkbox
                size="sm"
                checked={showAdvanced}
                onChange={(e) => setShowAdvanced(e.target.checked)}
                className="cursor-pointer"
              />
              Show advanced
            </label>
          </div>
        )}
        {layout.map((entry) => {
          if (entry.kind === 'subsection') return renderSubsection(entry.id)
          if (entry.id === 'trusted') return renderTrustedUsers()
          if (entry.id === 'retrieval') return renderRetrieval()
          if (entry.id === 'github_board') return renderGithubBoard()
          return null
        })}
      </>
    )
  }
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

          {renderTabBody()}

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
          <section className="bg-bg-secondary rounded-lg border border-border">
            <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
              <h3 className="text-sm font-semibold text-text-primary">Database Backup</h3>
              <p className="text-xs text-text-tertiary">Automatic Postgres backups + manual snapshot trigger</p>
            </div>
            <div className="px-5 py-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-sm text-text-primary mb-1.5">Auto-backup</label>
                <Select
                  value={settings.db_backup_enabled || 'true'}
                  onChange={(e) => handleChange('db_backup_enabled', e.target.value)}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </Select>
                <p className="text-xs text-text-tertiary mt-1.5">Runs in the background on the cron interval below.</p>
              </div>
              <div>
                <label className="block font-medium text-sm text-text-primary mb-1.5">Backup Interval (minutes)</label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={settings.db_backup_interval_minutes || '15'}
                  onChange={(e) => handleChange('db_backup_interval_minutes', e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1.5">How often the auto-backup fires. Default 15.</p>
              </div>
              <div>
                <label className="block font-medium text-sm text-text-primary mb-1.5">Recent backups to keep</label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={settings.backup_retention_count || '14'}
                  onChange={(e) => handleChange('backup_retention_count', e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1.5">Newest N pgdump files retained after each backup.</p>
              </div>
              <div>
                <label className="block font-medium text-sm text-text-primary mb-1.5">Weekly backups to keep</label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={settings.backup_retention_weekly_count || '8'}
                  onChange={(e) => handleChange('backup_retention_weekly_count', e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1.5">One older backup per week kept beyond the recent N.</p>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-border flex items-center gap-3">
              <Button
                onClick={handleBackup}
                disabled={backingUp}
                variant={backupResult ? 'success-solid' : 'solid'}
                disabledCursor={backingUp ? 'wait' : 'not-allowed'}
                className={`px-4 py-1.5 rounded-lg font-semibold ${
                  backupResult ? 'hover:bg-status-success' : ''
                } ${backingUp ? 'opacity-50 cursor-wait disabled:opacity-50' : ''}`}
              >
                {backingUp ? 'Backing up…' : backupResult ? 'Done!' : 'Manual Backup Now'}
              </Button>
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
