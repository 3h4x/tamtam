'use client'

import { useState, useEffect, useCallback } from 'react'
import { errMsg } from '@/lib/types'

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
}

export interface AgentTemplateRecord {
  name: string
  description: string
  model: string
  schedule: string
  runner: string
  prompt: string
  skillIds?: string[]
}

const DEFAULTS: SettingsMap = {
  workspace_path: '',
  github_owner: '',
  claude_provider: 'claude',
  claude_bin: '~/.local/bin/claude',
  lmstudio_model: '',
  log_dir: './data/logs',
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
  agent_templates: '',
  log_retention_count: '200',
  log_retention_days: '30',
  job_row_retention_days: '180',
  notification_webhook_url: '',
  notification_webhook_secret: '',
  notification_on_release_success: 'false',
  notification_on_release_fail: 'false',
  notification_on_release_aborted: 'false',
  notification_on_fix_loop_exhausted: 'false',
  notification_on_review_do_not_ship: 'false',
  notification_on_agent_run_fail: 'false',
}

interface FieldDef {
  label: string
  help: string
  group: 'workspace' | 'scheduling' | 'behavior'
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
  claude_provider: {
    label: 'Agent CLI Provider',
    help: 'Choose the Claude-compatible backend TamTam invokes for runs',
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
    help: 'Used for Claude or Custom provider. Gemini and LM Studio resolve to TamTam shim scripts.',
    group: 'workspace',
    span: 1,
  },
  lmstudio_model: {
    label: 'LM Studio Model',
    help: 'Downloaded LM Studio model identifier used when the LM Studio shim is selected',
    group: 'workspace',
    span: 1,
  },
  log_dir: {
    label: 'Log Directory',
    help: 'Directory where job logs are stored',
    group: 'workspace',
    span: 1,
  },
  launchagent_prefix: {
    label: 'LaunchAgent Prefix',
    help: 'Prefix for macOS LaunchAgent plist labels',
    group: 'workspace',
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
  agent_templates: {
    label: 'Agent Templates',
    help: 'JSON array of custom agent templates (managed via the Templates tab)',
    group: 'behavior',
    span: 2,
  },
  log_retention_count: {
    label: 'Log Retention (runs)',
    help: 'Keep log files for the last N finished runs per project. Older log files are deleted; the run row stays in history.',
    group: 'behavior',
    span: 1,
  },
  log_retention_days: {
    label: 'Log Retention (days)',
    help: 'Delete log files for runs older than this many days. Set to 0 to disable age-based pruning.',
    group: 'behavior',
    span: 1,
  },
  job_row_retention_days: {
    label: 'Run History Retention (days)',
    help: 'Nightly cleanup: delete run DB rows older than this many days. Set to 0 to disable.',
    group: 'behavior',
    span: 1,
  },
  notification_webhook_url: {
    label: 'Notification Webhook URL',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_webhook_secret: {
    label: 'Notification Webhook Secret',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_success: {
    label: 'Notification on Release Success',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_fail: {
    label: 'Notification on Release Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_aborted: {
    label: 'Notification on Release Aborted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_fix_loop_exhausted: {
    label: 'Notification on Fix Loop Exhausted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_review_do_not_ship: {
    label: 'Notification on Review Do Not Ship',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_agent_run_fail: {
    label: 'Notification on Agent Run Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
}

type TabId = 'behavior' | 'workspace' | 'scheduling' | 'projects' | 'database' | 'templates' | 'notifications'

const GROUPS: {
  id: TabId
  title: string
  description: string
  cols: number
}[] = [
  { id: 'behavior',   title: 'Agent Behavior', description: 'How Claude agents behave when running',                          cols: 2 },
  { id: 'workspace',  title: 'Workspace',       description: 'Where your projects live and how they connect to GitHub',        cols: 2 },
  { id: 'scheduling', title: 'Scheduling',      description: 'When and how often agents are allowed to run',                  cols: 3 },
]

const TABS: { id: TabId; label: string }[] = [
  { id: 'behavior',   label: 'Behavior' },
  { id: 'workspace',  label: 'Workspace' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'projects',   label: 'Projects' },
  { id: 'database',   label: 'Database' },
  { id: 'templates',  label: 'Templates' },
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

const TEMPLATE_MODELS = ['sonnet', 'opus', 'haiku']
const TEMPLATE_SCHEDULES = ['', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h']
const TEMPLATE_RUNNERS = ['pm2', 'launchctl']

const EMPTY_TEMPLATE: AgentTemplateRecord = { name: '', description: '', model: 'sonnet', schedule: '24h', runner: 'pm2', prompt: '' }

function AgentTemplatesTab({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parse = (v: string): AgentTemplateRecord[] => { try { return JSON.parse(v) } catch { return [] } }
  const [templates, setTemplates] = useState<AgentTemplateRecord[]>(() => parse(value))
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<AgentTemplateRecord>(EMPTY_TEMPLATE)

  const commit = (next: AgentTemplateRecord[]) => {
    setTemplates(next)
    onChange(next.length ? JSON.stringify(next) : '')
  }

  const openNew = () => { setForm(EMPTY_TEMPLATE); setEditing('new') }
  const openEdit = (i: number) => { setForm(templates[i]); setEditing(i) }
  const cancel = () => setEditing(null)

  const save = () => {
    if (!form.name.trim()) return
    const next = [...templates]
    if (editing === 'new') next.push(form)
    else if (typeof editing === 'number') next[editing] = form
    commit(next)
    setEditing(null)
  }

  const remove = (i: number) => {
    const next = templates.filter((_, idx) => idx !== i)
    commit(next)
    if (editing === i) setEditing(null)
  }

  const setField = (k: keyof AgentTemplateRecord, v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <section className="bg-bg-secondary rounded-lg border border-border">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Agent Templates</h3>
          <p className="text-xs text-text-tertiary">Custom templates shown in the Recommended section on each project</p>
        </div>
        {editing === null && (
          <button
            onClick={openNew}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer transition-colors"
          >
            + Add Template
          </button>
        )}
      </div>

      <div className="px-5 py-4 flex flex-col gap-3">
        {templates.length === 0 && editing === null && (
          <p className="text-sm text-text-tertiary text-center py-4">
            No custom templates yet. Add one to override or extend the built-in recommended agents.
          </p>
        )}

        {templates.map((t, i) => (
          editing === i ? (
            <TemplateForm key={i} form={form} setField={setField} onSave={save} onCancel={cancel} isEdit />
          ) : (
            <div key={i} className="p-3 rounded-lg border border-border bg-bg-primary flex items-start justify-between gap-4">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="font-medium text-sm text-text-primary">{t.name}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">{t.model}</span>
                {t.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">every {t.schedule}</span>}
                {t.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{t.description}</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => openEdit(i)}
                  className="px-2.5 py-1 text-xs border border-border rounded bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => remove(i)}
                  className="px-2.5 py-1 text-xs border border-status-error/30 rounded text-status-error hover:bg-status-error/10 cursor-pointer transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          )
        ))}

        {editing === 'new' && (
          <TemplateForm form={form} setField={setField} onSave={save} onCancel={cancel} isEdit={false} />
        )}
      </div>
    </section>
  )
}

function TemplateForm({
  form, setField, onSave, onCancel, isEdit,
}: {
  form: AgentTemplateRecord
  setField: (k: keyof AgentTemplateRecord, v: string) => void
  onSave: () => void
  onCancel: () => void
  isEdit: boolean
}) {
  return (
    <div className="p-4 rounded-lg border border-accent/30 bg-accent/5 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setField('name', e.target.value)}
            placeholder="e.g. security-review"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            placeholder="Short description shown in the list"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Model</label>
          <select
            value={form.model}
            onChange={e => setField('model', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            {TEMPLATE_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Schedule</label>
          <select
            value={form.schedule}
            onChange={e => setField('schedule', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            <option value="">Manual</option>
            {TEMPLATE_SCHEDULES.filter(Boolean).map(s => <option key={s} value={s}>every {s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Runner</label>
          <select
            value={form.runner}
            onChange={e => setField('runner', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            {TEMPLATE_RUNNERS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-primary mb-1">Prompt</label>
        <textarea
          value={form.prompt}
          onChange={e => setField('prompt', e.target.value)}
          placeholder="What should this agent do when it runs?"
          rows={4}
          className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent font-mono resize-y"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={!form.name.trim()}
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isEdit ? 'Save' : 'Add Template'}
        </button>
      </div>
    </div>
  )
}

function NotificationsTab({
  settings,
  onChange,
}: {
  settings: SettingsMap
  onChange: (key: keyof SettingsMap, value: string) => void
}) {
  const [testSending, setTestSending] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testSuccess, setTestSuccess] = useState(false)

  const handleTestNotification = async () => {
    if (!settings.notification_webhook_url) {
      setTestError('Webhook URL is required')
      return
    }

    setTestSending(true)
    setTestError(null)
    setTestSuccess(false)

    try {
      const res = await fetch('/api/settings/test-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_url: settings.notification_webhook_url,
          webhook_secret: settings.notification_webhook_secret,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to send test notification')
      }
      setTestSuccess(true)
      setTimeout(() => setTestSuccess(false), 3000)
    } catch (e: unknown) {
      setTestError(errMsg(e))
      setTimeout(() => setTestError(null), 5000)
    } finally {
      setTestSending(false)
    }
  }

  const eventToggles = [
    { key: 'notification_on_release_success' as const, label: 'Release Success', description: 'When a release pipeline completes successfully' },
    { key: 'notification_on_release_fail' as const, label: 'Release Failure', description: 'When a release pipeline fails' },
    { key: 'notification_on_release_aborted' as const, label: 'Release Aborted', description: 'When a release pipeline is aborted mid-run' },
    { key: 'notification_on_fix_loop_exhausted' as const, label: 'Fix Loop Exhausted', description: 'When the fix loop reaches its retry limit' },
    { key: 'notification_on_review_do_not_ship' as const, label: 'Review: Do Not Ship', description: 'When a review verdict is "DO NOT SHIP"' },
    { key: 'notification_on_agent_run_fail' as const, label: 'Agent Run Failure', description: 'When an agent run fails' },
  ]

  return (
    <section className="space-y-4">
      {/* Webhook Configuration */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Webhook Configuration</h3>
          <p className="text-xs text-text-tertiary">Configure outbound notifications for release pipeline events</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Webhook URL</label>
            <input
              type="text"
              value={settings.notification_webhook_url}
              onChange={(e) => onChange('notification_webhook_url', e.target.value)}
              placeholder="https://hooks.slack.com/services/... or https://discordapp.com/api/webhooks/... or any webhook endpoint"
              className={INPUT_CLASS}
            />
            <p className="text-xs text-text-tertiary mt-1.5">Supports Slack, Discord, ntfy, and generic JSON POST webhooks</p>
          </div>

          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Webhook Secret (Optional)</label>
            <input
              type="password"
              value={settings.notification_webhook_secret}
              onChange={(e) => onChange('notification_webhook_secret', e.target.value)}
              placeholder="Secret for HMAC-SHA256 signature verification"
              className={INPUT_CLASS}
            />
            <p className="text-xs text-text-tertiary mt-1.5">If set, payloads will be signed with <code className="bg-bg-tertiary px-1 rounded">X-TamTam-Signature</code> header</p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleTestNotification}
              disabled={testSending || !settings.notification_webhook_url}
              className={`px-4 py-1.5 text-white border-none rounded-lg font-semibold text-sm cursor-pointer transition-colors ${
                testSuccess ? 'bg-status-success' : 'bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed'
              } ${testSending ? 'opacity-50 cursor-wait' : ''}`}
            >
              {testSending ? 'Sending…' : testSuccess ? 'Sent!' : 'Send Test'}
            </button>
            {testError && (
              <span className="text-sm text-status-error">{testError}</span>
            )}
          </div>
        </div>
      </div>

      {/* Event Toggles */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Notification Events</h3>
          <p className="text-xs text-text-tertiary">Choose which events trigger notifications</p>
        </div>
        <div className="px-5 py-4 space-y-3">
          {eventToggles.map(({ key, label, description }) => (
            <label
              key={key}
              className="flex items-start gap-3 p-3 rounded-lg hover:bg-bg-tertiary/50 cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={settings[key] === 'true'}
                onChange={(e) => onChange(key, e.target.checked ? 'true' : 'false')}
                className="w-4 h-4 accent-accent rounded mt-0.5 shrink-0 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-text-primary">{label}</div>
                <div className="text-xs text-text-tertiary">{description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}

function SettingsField({
  fieldKey,
  value,
  provider,
  onChange,
}: {
  fieldKey: keyof SettingsMap
  value: string
  provider?: string
  onChange: (key: keyof SettingsMap, value: string) => void
}) {
  const field = FIELDS[fieldKey]
  const colSpanClass = COL_SPAN[field.span ?? 1] ?? 'col-span-1'
  const shimManaged = fieldKey === 'claude_bin' && (provider === 'gemini' || provider === 'lmstudio')

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
      ) : fieldKey === 'claude_provider' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="claude">Claude CLI</option>
          <option value="gemini">Gemini shim</option>
          <option value="lmstudio">LM Studio shim</option>
          <option value="custom">Custom executable</option>
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
          value={shimManaged ? `Managed by ${provider === 'gemini' ? 'Gemini' : 'LM Studio'} shim` : value}
          disabled={shimManaged}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey] || `Enter ${field.label.toLowerCase()}`}
          className={`${INPUT_CLASS} ${shimManaged ? 'opacity-70 cursor-not-allowed' : ''}`}
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
        <div className="space-y-4 animate-pulse">
          <div className="bg-bg-secondary rounded-lg border border-border h-48" />
          <div className="bg-bg-secondary rounded-lg border border-border h-64" />
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
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1 animate-pulse">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="h-10 rounded-lg bg-bg-secondary border border-border" style={{ opacity: 1 - i * 0.1 }} />
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
              settings={settings}
              onChange={handleChange}
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
