'use client'

import { FIELDS, DEFAULTS, COL_SPAN } from '@/components/settings/constants'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import type { SettingsFieldKey } from '@/components/settings/constants'
import { MODEL_TIERS, MODEL_LABELS, getProviderModelHint } from '@/lib/agents/model-aliases'

export type { SettingsFieldKey }

const BOOLEAN_SELECT_FIELD_KEYS = new Set<SettingsFieldKey>([
  'project_sweep_enabled',
  'incremental_review_enabled',
  'legacy_completion_hook_release_after_run_enabled',
  'legacy_completion_hook_release_after_fix_ci_enabled',
  'legacy_completion_hook_auto_resume_enabled',
  'legacy_pipeline_lock_inline_drain_enabled',
  'legacy_completion_hook_agent_drain_enabled',
  'plain_test_phase_enabled',
  'auto_fix_ci_on_red_default_branch',
  'browser_broker_enabled',
  'tamtam_network_policy_strict',
  'orchestrator_enabled',
  'auto_pause_unfruitful_enabled',
  'agent_autopilot_enabled',
  'initiative_engine_enabled',
  'initiative_mining_enabled',
  'initiative_dispatch_enabled',
])

const LONG_TEXT_KEYS = new Set<SettingsFieldKey>(['base_prompt', 'commit_style', 'review_verdict_rules'])

function summarize(value: string, fallback: string): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return fallback
  const firstLine = trimmed.split(/\r?\n/)[0]
  return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine
}

function pipelineModelDefaultLabel(fieldKey: SettingsFieldKey): string {
  if (fieldKey === 'pipeline_model_fix') return 'Default (Smart)'
  if (fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit') return 'Default (Fast)'
  return 'Default (workspace)'
}

export function SettingsField({
  fieldKey,
  value,
  provider,
  onChange,
}: {
  fieldKey: SettingsFieldKey
  value: string
  provider?: string
  onChange: (key: SettingsFieldKey, value: string) => void
}) {
  const field = FIELDS[fieldKey]
  const colSpanClass = COL_SPAN[field.span ?? 1] ?? 'col-span-1'
  const shimManaged = fieldKey === 'claude_bin' && (provider === 'claude' || provider === 'gemini' || provider === 'lmstudio' || provider === 'codex' || provider === 'deepagents')
  const shimDisplay = shimManaged
    ? `<TamTam>/scripts/${provider === 'gemini' ? 'gemini-shim.js' : provider === 'lmstudio' ? 'lmstudio-shim.js' : provider === 'codex' ? 'codex-shim.js' : provider === 'deepagents' ? 'deepagents-shim.js' : 'claude-shim.js'}`
    : ''

  if (LONG_TEXT_KEYS.has(fieldKey) && field.collapsible) {
    const placeholderText = DEFAULTS[fieldKey] || ''
    const preview = summarize(value, placeholderText ? summarize(placeholderText, '(empty)') : '(empty)')
    return (
      <details className={colSpanClass}>
        <summary className="cursor-pointer list-none group">
          <div className="flex items-baseline gap-2 mb-1.5">
            <svg className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90 text-text-tertiary"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium text-sm text-text-primary">{field.label}</span>
            <span className="text-xs text-text-tertiary font-mono truncate">{preview}</span>
          </div>
        </summary>
        <Textarea
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey]}
          rows={fieldKey === 'review_verdict_rules' ? 8 : 3}
          fontSize="xs"
        />
        <p className="text-xs text-text-tertiary mt-1.5">{field.help}</p>
      </details>
    )
  }

  return (
    <div className={colSpanClass}>
      <label className="block font-medium text-sm text-text-primary mb-1.5">{field.label}</label>
      {LONG_TEXT_KEYS.has(fieldKey) ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey]}
          rows={fieldKey === 'review_verdict_rules' ? 8 : 3}
          fontSize="xs"
        />
      ) : fieldKey === 'daytime' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="false">Night only (20:00–05:59)</option>
          <option value="true">Any time (24/7)</option>
        </Select>
      ) : fieldKey === 'weekends' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="off">Weekdays only</option>
          <option value="on">Include weekends</option>
        </Select>
      ) : fieldKey === 'claude_provider' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="claude">Claude CLI</option>
          <option value="gemini">Gemini shim</option>
          <option value="lmstudio">LM Studio shim</option>
          <option value="codex">Codex shim</option>
          <option value="deepagents">Deep Agents shim</option>
          <option value="custom">Custom executable</option>
        </Select>
      ) : fieldKey === 'default_model' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          {MODEL_TIERS.map((model) => {
            const hint = getProviderModelHint(provider, model)
            return <option key={model} value={model}>{hint ? `${MODEL_LABELS[model]} → ${hint}` : MODEL_LABELS[model]}</option>
          })}
        </Select>
      ) : fieldKey === 'pipeline_model_review' || fieldKey === 'pipeline_model_fix' || fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="">{pipelineModelDefaultLabel(fieldKey)}</option>
          {MODEL_TIERS.map((model) => <option key={model} value={model}>{MODEL_LABELS[model]}</option>)}
        </Select>
      ) : fieldKey === 'fix_max_iterations'
          || fieldKey === 'prompt_estimate_warn_tokens'
          || fieldKey === 'prompt_estimate_block_tokens'
          || fieldKey === 'release_min_lines'
          || fieldKey === 'auto_pause_unfruitful_runs'
          || fieldKey === 'release_reinforce_max_iterations'
          || fieldKey === 'orchestrator_boost_margin_pct'
          || fieldKey === 'orchestrator_max_boosts_per_hour'
          || fieldKey === 'initiative_max_ships_per_day'
          || fieldKey === 'initiative_max_backlog_per_project'
          || fieldKey === 'initiative_mining_interval_minutes' ? (
        <Input
          type="number"
          min={0}
          step={1}
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey]}
        />
      ) : fieldKey === 'browser_broker_mode' ? (
        <Select value={value || 'docker'} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="docker">docker (sandboxed container)</option>
          <option value="host">host (direct, no container sandbox)</option>
        </Select>
      ) : fieldKey === 'review_do_not_ship_action' ? (
        <Select value={value || 'fix'} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="pass">Pass with follow-up issue</option>
          <option value="fix">Try fix loop (default)</option>
          <option value="abort">Abort release</option>
        </Select>
      ) : BOOLEAN_SELECT_FIELD_KEYS.has(fieldKey) ? (
        <Select value={value || 'false'} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </Select>
      ) : fieldKey === 'permission_mode' ? (
        <Select value={value} onChange={(e) => onChange(fieldKey, e.target.value)}>
          <option value="bypassPermissions">bypassPermissions</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="auto">auto</option>
          <option value="dontAsk">dontAsk</option>
          <option value="plan">plan</option>
          <option value="default">default</option>
        </Select>
      ) : (
        <Input
          type="text"
          value={shimManaged ? shimDisplay : value}
          disabled={shimManaged}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          placeholder={DEFAULTS[fieldKey] || `Enter ${field.label.toLowerCase()}`}
          className={shimManaged ? 'opacity-70 cursor-not-allowed' : ''}
        />
      )}
      <p className="text-xs text-text-tertiary mt-1.5">{field.help}</p>
    </div>
  )
}
