'use client'

import { FIELDS, DEFAULTS, COL_SPAN, SELECT_CLASS, INPUT_CLASS } from '@/components/settings/constants'
import type { SettingsFieldKey } from '@/components/settings/constants'

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
  const shimManaged = fieldKey === 'claude_bin' && (provider === 'gemini' || provider === 'lmstudio')
  const shimDisplay = shimManaged
    ? `<TamTam>/scripts/${provider === 'gemini' ? 'gemini-shim.js' : 'lmstudio-shim.js'}`
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
          <option value="custom">Custom executable</option>
        </select>
      ) : fieldKey === 'default_model' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          {provider === 'gemini' ? (
            <>
              <option value="haiku">haiku → flash</option>
              <option value="sonnet">sonnet → pro</option>
              <option value="opus">opus → pro</option>
            </>
          ) : (
            <>
              <option value="haiku">haiku</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </>
          )}
        </select>
      ) : fieldKey === 'pipeline_model_review' || fieldKey === 'pipeline_model_fix' || fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit' ? (
        <select value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={SELECT_CLASS}>
          <option value="">{(fieldKey === 'pipeline_model_dod' || fieldKey === 'pipeline_model_commit') ? 'Default (haiku)' : 'Default (workspace)'}</option>
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
