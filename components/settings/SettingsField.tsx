'use client'

import { FIELDS, DEFAULTS, COL_SPAN, SELECT_CLASS, INPUT_CLASS } from '@/components/settings/constants'
import type { SettingsFieldKey } from '@/components/settings/constants'
import { MODEL_TIERS, MODEL_LABELS, getProviderModelHint } from '@/lib/agents/model-aliases'

export type { SettingsFieldKey }

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
  const shimManaged = fieldKey === 'claude_bin' && (provider === 'claude' || provider === 'gemini' || provider === 'lmstudio' || provider === 'codex')
  const shimDisplay = shimManaged
    ? `<TamTam>/scripts/${provider === 'gemini' ? 'gemini-shim.js' : provider === 'lmstudio' ? 'lmstudio-shim.js' : provider === 'codex' ? 'codex-shim.js' : 'claude-shim.js'}`
    : ''

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
          <option value="codex">Codex shim</option>
          <option value="custom">Custom executable</option>
        </select>
      ) : fieldKey === 'default_model' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          {MODEL_TIERS.map((model) => {
            const hint = getProviderModelHint(provider, model)
            return <option key={model} value={model}>{hint ? `${MODEL_LABELS[model]} → ${hint}` : MODEL_LABELS[model]}</option>
          })}
        </select>
      ) : fieldKey === 'pipeline_model_review' || fieldKey === 'pipeline_model_fix' || fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="">{(fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit') ? 'Default (Fast)' : 'Default (workspace)'}</option>
          {MODEL_TIERS.map((model) => <option key={model} value={model}>{MODEL_LABELS[model]}</option>)}
        </select>
      ) : fieldKey === 'review_do_not_ship_action' ? (
        <select value={value || 'pass'} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="pass">Pass with follow-up issue</option>
          <option value="fix">Try fix loop</option>
          <option value="abort">Abort release</option>
        </select>
      ) : fieldKey === 'permission_mode' ? (
        <>
          <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
            <option value="bypassPermissions">bypassPermissions</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="auto">auto</option>
            <option value="dontAsk">dontAsk</option>
            <option value="plan">plan</option>
            <option value="default">default</option>
          </select>
          {value === 'auto' && (
            <div className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning" role="alert">
              <span className="font-medium">Warning:</span> auto preserves provider-native approval behavior. On CLIs that still prompt for write approval in headless mode, unattended jobs can block. Prefer acceptEdits for background runs.
            </div>
          )}
        </>
      ) : (
        <input
          type="text"
          value={shimManaged ? shimDisplay : value}
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
