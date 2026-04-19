'use client'

import { useState, useEffect, useCallback } from 'react'
import { errMsg } from '@/lib/types'

interface SettingsMap {
  workspace_path: string
  github_owner: string
  claude_bin: string
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
  fix_ci_max_retries: string
  fix_ci_retry_window_seconds: string
  fix_ci_fast_crash_ms: string
}

const DEFAULTS: SettingsMap = {
  workspace_path: '',
  github_owner: '',
  claude_bin: '~/.local/bin/claude',
  log_dir: '~/logs',
  frequency: '1h',
  daytime: 'false',
  weekends: 'off',
  launchagent_prefix: 'com.tamtam',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'haiku',
  permission_mode: 'bypassPermissions',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `STRICT verdict rules — the user cares about code quality, not speed:
- LGTM ONLY when there are zero findings at any severity. Not "LGTM with minor notes", not "LGTM aside from a nit". If you list any "minor" / "non-blocking" / "cosmetic" / "consider..." / "nice-to-have" issue, that is NEEDS ATTENTION, not LGTM.
- NEEDS ATTENTION when you have at least one finding but nothing that risks data loss, security regressions, or breakage in production. Orphaned code, dead imports, missing imports that happen to compile, hardcoded strings that should use env vars, non-ideal UX state leaks, stylistic inconsistencies — all NEEDS ATTENTION.
- DO NOT SHIP when there is a real risk of breakage, data loss, security regression, or a test that hides behavior.
- If LGTM, just confirm the changes look good and add nothing else.`,
  fix_ci_max_retries: '2',
  fix_ci_retry_window_seconds: '120',
  fix_ci_fast_crash_ms: '5000',
}

interface FieldDef {
  label: string
  help: string
  group: 'workspace' | 'scheduling' | 'system' | 'behavior'
  advanced?: boolean
  span?: number  // column span within the group grid
}

const FIELDS: Record<keyof SettingsMap, FieldDef> = {
  workspace_path: {
    label: 'Workspace Path',
    help: 'Root directory containing your git projects',
    group: 'workspace',
    span: 2,
  },
  github_owner: {
    label: 'GitHub Owner',
    help: 'Default GitHub org/user for repos without an explicit remote',
    group: 'workspace',
    span: 1,
  },
  frequency: {
    label: 'Base Frequency',
    help: 'How often scheduled agents run, e.g. "1h", "30m"',
    group: 'scheduling',
    span: 1,
  },
  daytime: {
    label: 'Allowed Hours',
    help: 'Time window when agents are permitted to run',
    group: 'scheduling',
    span: 1,
  },
  weekends: {
    label: 'Weekend Runs',
    help: 'Whether agents run on Saturdays and Sundays',
    group: 'scheduling',
    span: 1,
  },
  claude_bin: {
    label: 'Claude CLI Path',
    help: 'Absolute path to the Claude CLI binary',
    group: 'system',
    span: 1,
  },
  log_dir: {
    label: 'Log Directory',
    help: 'Directory where job logs are stored',
    group: 'system',
    span: 1,
  },
  launchagent_prefix: {
    label: 'LaunchAgent Prefix',
    help: 'Prefix for macOS LaunchAgent plist labels',
    group: 'system',
    advanced: true,
    span: 1,
  },
  base_prompt: {
    label: 'Base Prompt',
    help: 'Prepended to every Claude invocation — runs, agents, and reviews',
    group: 'behavior',
    span: 2,
  },
  default_model: {
    label: 'Default Model',
    help: 'Model pre-selected in the terminal runner',
    group: 'behavior',
    span: 1,
  },
  permission_mode: {
    label: 'Permission Mode',
    help: 'Controls which operations Claude can perform without prompting',
    group: 'behavior',
    span: 1,
  },
  commit_style: {
    label: 'Commit Message Style',
    help: 'Style guide injected into the prompt when generating commit titles in the Push panel',
    group: 'behavior',
    span: 2,
  },
  review_verdict_rules: {
    label: 'Review Verdict Rules',
    help: 'Rules that drive LGTM / NEEDS ATTENTION / DO NOT SHIP decisions in code reviews',
    group: 'behavior',
    span: 2,
  },
  fix_ci_max_retries: {
    label: 'Fix-CI Max Retries',
    help: 'How many times to auto-retry a fix-ci job that crashes fast before giving up. 0 disables retries.',
    group: 'behavior',
    span: 1,
  },
  fix_ci_retry_window_seconds: {
    label: 'Fix-CI Retry Window (s)',
    help: 'Window in seconds within which retries are counted toward the cap',
    group: 'behavior',
    advanced: true,
    span: 1,
  },
  fix_ci_fast_crash_ms: {
    label: 'Fix-CI Fast-Crash (ms)',
    help: 'Duration under which a non-zero exit is treated as a boot crash and retried. Longer failures surface as-is.',
    group: 'behavior',
    advanced: true,
    span: 1,
  },
}

type TabId = 'behavior' | 'workspace' | 'scheduling' | 'system' | 'projects' | 'database'

const GROUPS: {
  id: TabId
  title: string
  description: string
  cols: number
}[] = [
  { id: 'behavior',   title: 'Agent Behavior', description: 'How Claude agents behave when running',                          cols: 2 },
  { id: 'workspace',  title: 'Workspace',       description: 'Where your projects live and how they connect to GitHub',        cols: 2 },
  { id: 'scheduling', title: 'Scheduling',      description: 'When and how often agents are allowed to run',                  cols: 3 },
  { id: 'system',     title: 'System',          description: 'Paths and platform-specific configuration',                     cols: 2 },
]

const TABS: { id: TabId; label: string }[] = [
  { id: 'behavior',   label: 'Behavior' },
  { id: 'workspace',  label: 'Workspace' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'system',     label: 'System' },
  { id: 'projects',   label: 'Projects' },
  { id: 'database',   label: 'Database' },
]

const COL_SPAN: Record<number, string> = { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3' }
const GRID_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3' }

const SELECT_CLASS = 'w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors'
const INPUT_CLASS  = 'w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors placeholder:text-text-tertiary'

interface ProjectEntry {
  name: string
  path: string
  enabled: boolean
  github: string | null
  priority: string | null
}

function SettingsField({
  fieldKey,
  value,
  onChange,
}: {
  fieldKey: keyof SettingsMap
  value: string
  onChange: (key: keyof SettingsMap, value: string) => void
}) {
  const field = FIELDS[fieldKey]
  const colSpanClass = COL_SPAN[field.span ?? 1] ?? 'col-span-1'

  return (
    <div className={colSpanClass}>
      <label className="block font-medium text-sm text-text-primary mb-1.5">{field.label}</label>
      {fieldKey === 'base_prompt' || fieldKey === 'commit_style' || fieldKey === 'review_verdict_rules' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey]}
          rows={fieldKey === 'review_verdict_rules' ? 8 : 3}
          className="w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors placeholder:text-text-tertiary resize-y"
        />
      ) : fieldKey === 'daytime' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="false">Night only (20:00–05:59)</option>
          <option value="true">Any time (24/7)</option>
        </select>
      ) : fieldKey === 'weekends' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="off">Weekdays only</option>
          <option value="on">Include weekends</option>
        </select>
      ) : fieldKey === 'default_model' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="haiku">haiku</option>
          <option value="sonnet">sonnet</option>
          <option value="opus">opus</option>
        </select>
      ) : fieldKey === 'permission_mode' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="bypassPermissions">bypassPermissions</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="auto">auto</option>
          <option value="dontAsk">dontAsk</option>
          <option value="plan">plan</option>
          <option value="default">default</option>
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey] || `Enter ${field.label.toLowerCase()}`}
          className={INPUT_CLASS}
        />
      )}
      <p className="text-xs text-text-tertiary mt-1.5">{field.help}</p>
    </div>
  )
}

export function SettingsPage() {
  const [settings, setSettings]           = useState<SettingsMap>({ ...DEFAULTS })
  const [savedSettings, setSavedSettings] = useState<SettingsMap>({ ...DEFAULTS })
  const [loading, setLoading]             = useState(true)
  const [saving, setSaving]               = useState(false)
  const [saved, setSaved]                 = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced]   = useState(false)
  const [activeTab, setActiveTab]         = useState<TabId>(() => {
    if (typeof window === 'undefined') return 'behavior'
    const stored = localStorage.getItem('tamtam-settings-tab') as TabId | null
    return stored && TABS.some(t => t.id === stored) ? stored : 'behavior'
  })
  const switchTab = (id: TabId) => {
    setActiveTab(id)
    try { localStorage.setItem('tamtam-settings-tab', id) } catch {}
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
        const loaded = { ...DEFAULTS, ...data.settings }
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
    setSettings((prev) => ({ ...prev, [key]: value }))
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
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Settings</h2>
          <p className="text-sm text-text-secondary mt-0.5">Configure how TamTam discovers and manages your projects.</p>
        </div>
        <div className="flex items-center gap-3">
          {isDirty && !saving && (
            <span className="text-xs text-text-tertiary">Unsaved changes · ⌘S</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className={`px-4 py-2 text-white border-none rounded-lg font-semibold text-sm transition-colors ${
              saved      ? 'bg-status-success cursor-default' :
              isDirty    ? 'bg-accent hover:bg-accent-hover cursor-pointer' :
                           'bg-accent/40 cursor-default'
            } ${saving ? 'opacity-50 cursor-wait' : ''}`}
          >
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 justify-center py-12">
          <div className="spinner" />
          <span className="text-text-secondary">Loading settings…</span>
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
            const allGroupFields = (Object.keys(FIELDS) as (keyof SettingsMap)[]).filter(
              (k) => FIELDS[k].group === group.id
            )
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
                      <SettingsField key={key} fieldKey={key} value={settings[key]} onChange={handleChange} />
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
                            <SettingsField key={key} fieldKey={key} value={settings[key]} onChange={handleChange} />
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
                  <div className="flex items-center gap-2 justify-center py-6">
                    <div className="spinner" />
                    <span className="text-text-secondary text-sm">Scanning workspace…</span>
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
                        className={`px-4 py-1.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                          projectsSaved ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
                        } ${projectsSaving ? 'opacity-50 cursor-wait' : ''}`}
                      >
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
