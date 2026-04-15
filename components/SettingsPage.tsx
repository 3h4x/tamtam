'use client'

import { useState, useEffect, useCallback } from 'react'

interface SettingsMap {
  workspace_path: string
  github_owner: string
  claude_bin: string
  log_dir: string
  frequency: string
  daytime: string
  weekends: string
  launchagent_prefix: string
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
}

interface FieldDef {
  label: string
  help: string
  group: 'workspace' | 'scheduling' | 'system'
}

const FIELDS: Record<keyof SettingsMap, FieldDef> = {
  workspace_path: {
    label: 'Workspace Path',
    help: 'Root directory containing your git projects',
    group: 'workspace',
  },
  github_owner: {
    label: 'GitHub Owner',
    help: 'Default GitHub org/user for repos without explicit config',
    group: 'workspace',
  },
  frequency: {
    label: 'Base Frequency',
    help: 'Base scheduling frequency (e.g. "1h", "30m", "2h")',
    group: 'scheduling',
  },
  daytime: {
    label: 'Daytime Mode',
    help: 'When agents are allowed to run',
    group: 'scheduling',
  },
  weekends: {
    label: 'Weekends',
    help: 'Whether to run agents on weekends',
    group: 'scheduling',
  },
  claude_bin: {
    label: 'Claude CLI Path',
    help: 'Path to the Claude CLI binary',
    group: 'system',
  },
  log_dir: {
    label: 'Log Directory',
    help: 'Directory for job logs',
    group: 'system',
  },
  launchagent_prefix: {
    label: 'LaunchAgent Prefix',
    help: 'macOS LaunchAgent label prefix',
    group: 'system',
  },
}

const GROUPS = [
  { id: 'workspace' as const, title: 'Workspace', description: 'Where your projects live and how they connect to GitHub' },
  { id: 'scheduling' as const, title: 'Scheduling', description: 'Control when and how often agents run' },
  { id: 'system' as const, title: 'System', description: 'Paths and platform-specific configuration' },
]

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
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="block font-medium text-sm text-text-primary">
          {field.label}
        </label>
        <span className="text-xs text-text-tertiary">{field.help}</span>
      </div>
      {fieldKey === 'daytime' ? (
        <select
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          className="w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
        >
          <option value="false">Night only (20:00 - 05:59)</option>
          <option value="true">24/7</option>
        </select>
      ) : fieldKey === 'weekends' ? (
        <select
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          className="w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
        >
          <option value="off">Skip weekends</option>
          <option value="on">Include weekends</option>
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey] || `Enter ${field.label.toLowerCase()}`}
          className="w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors placeholder:text-text-tertiary"
        />
      )}
    </div>
  )
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap>({ ...DEFAULTS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsSaving, setProjectsSaving] = useState(false)
  const [projectsSaved, setProjectsSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setSettings({ ...DEFAULTS, ...data.settings })
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
      .catch(() => {
        setProjectsLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!loading && settings.workspace_path) {
      loadProjects()
    }
  }, [loading, settings.workspace_path, loadProjects])

  const handleSave = async () => {
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
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      loadProjects()
    } catch (e: any) {
      setError(`Failed to save: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (key: keyof SettingsMap, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const toggleProject = (name: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.name === name ? { ...p, enabled: !p.enabled } : p))
    )
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
      setTimeout(() => setProjectsSaved(false), 3000)
    } catch (e: any) {
      setError(`Failed to save projects: ${e.message}`)
    } finally {
      setProjectsSaving(false)
    }
  }

  const [backingUp, setBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<{ filename: string } | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)

  const handleBackup = async () => {
    setBackingUp(true)
    setBackupResult(null)
    setBackupError(null)
    try {
      const res = await fetch('/api/settings/backup', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setBackupResult({ filename: data.filename })
      setTimeout(() => setBackupResult(null), 5000)
    } catch (e: any) {
      setBackupError(e.message)
      setTimeout(() => setBackupError(null), 5000)
    } finally {
      setBackingUp(false)
    }
  }

  const enabledCount = projects.filter((p) => p.enabled).length

  return (
    <div className="max-w-[720px]">
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-text-primary">Settings</h2>
        <p className="text-sm text-text-secondary mt-1">Configure how TamTam discovers and manages your projects.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 justify-center py-12">
          <div className="spinner" />
          <span className="text-text-secondary">Loading settings...</span>
        </div>
      ) : (
        <div className="space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error text-sm">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {error}
            </div>
          )}

          {GROUPS.map((group) => {
            const groupFields = (Object.keys(FIELDS) as (keyof SettingsMap)[]).filter(
              (k) => FIELDS[k].group === group.id
            )
            return (
              <section key={group.id} className="bg-bg-secondary rounded-lg border border-border">
                <div className="px-5 py-4 border-b border-border">
                  <h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
                  <p className="text-xs text-text-tertiary mt-0.5">{group.description}</p>
                </div>
                <div className="px-5 py-4 space-y-4">
                  {groupFields.map((key) => (
                    <SettingsField
                      key={key}
                      fieldKey={key}
                      value={settings[key]}
                      onChange={handleChange}
                    />
                  ))}
                </div>
              </section>
            )
          })}

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-5 py-2.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                saved ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
              } ${saving ? 'opacity-50 cursor-wait' : ''}`}
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
            </button>
            {saved && (
              <span className="text-sm text-status-success">Settings updated successfully</span>
            )}
          </div>

          {/* Projects section */}
          {settings.workspace_path && (
            <section className="bg-bg-secondary rounded-lg border border-border">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Projects</h3>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    Git repositories in <code className="font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-text-secondary">{settings.workspace_path}</code>
                    {projects.length > 0 && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent">
                        {enabledCount}/{projects.length} enabled
                      </span>
                    )}
                  </p>
                </div>
                {projects.length > 0 && (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => toggleAll(true)}
                      className="px-3 py-1.5 text-xs border border-border rounded-md bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => toggleAll(false)}
                      className="px-3 py-1.5 text-xs border border-border rounded-md bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    >
                      Deselect all
                    </button>
                  </div>
                )}
              </div>

              <div className="px-5 py-4">
                {projectsLoading ? (
                  <div className="flex items-center gap-2 justify-center py-6">
                    <div className="spinner" />
                    <span className="text-text-secondary text-sm">Scanning workspace...</span>
                  </div>
                ) : projects.length === 0 ? (
                  <div className="text-text-secondary text-sm py-6 text-center">
                    No git repositories found. Save your workspace path first.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-1">
                      {projects.map((proj) => (
                        <label
                          key={proj.name}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                            proj.enabled
                              ? 'bg-accent/8 border border-accent/20'
                              : 'border border-transparent hover:bg-bg-tertiary'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={proj.enabled}
                            onChange={() => toggleProject(proj.name)}
                            className="w-4 h-4 accent-accent rounded"
                          />
                          <span className={`font-mono text-sm ${proj.enabled ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                            {proj.name}
                          </span>
                          <span className="text-xs text-text-tertiary ml-auto truncate max-w-[280px]">
                            {proj.path}
                          </span>
                        </label>
                      ))}
                    </div>

                    <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
                      <button
                        onClick={saveProjects}
                        disabled={projectsSaving}
                        className={`px-5 py-2.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                          projectsSaved ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
                        } ${projectsSaving ? 'opacity-50 cursor-wait' : ''}`}
                      >
                        {projectsSaving
                          ? 'Saving...'
                          : projectsSaved
                            ? 'Projects Saved!'
                            : `Save Projects (${enabledCount} enabled)`}
                      </button>
                      {projectsSaved && (
                        <span className="text-sm text-status-success">Project selection updated</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Database Backup */}
          <section className="bg-bg-secondary rounded-lg border border-border">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-text-primary">Database Backup</h3>
              <p className="text-xs text-text-tertiary mt-0.5">Create a manual backup of the SQLite database</p>
            </div>
            <div className="px-5 py-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleBackup}
                  disabled={backingUp}
                  className={`px-5 py-2.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                    backupResult ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover'
                  } ${backingUp ? 'opacity-50 cursor-wait' : ''}`}
                >
                  {backingUp ? 'Backing up...' : backupResult ? 'Backup Created!' : 'Create Backup'}
                </button>
                {backupResult && (
                  <span className="text-sm text-status-success">
                    Saved as <code className="font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-text-secondary">{backupResult.filename}</code>
                  </span>
                )}
                {backupError && (
                  <span className="text-sm text-status-error">{backupError}</span>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
