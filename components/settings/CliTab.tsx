'use client'

import { useEffect, useState } from 'react'
import {
  CLI_PROVIDERS,
  encodeEnabledProviders,
  parseEnabledProviders,
  type CliProvider,
} from '@/lib/usage/cli-providers'
import { loadQuotaSnapshot } from '@/lib/client/quota'

const INPUT_CLASS =
  'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono'
const SELECT_CLASS = INPUT_CLASS + ' appearance-none'

const PROVIDER_LABELS: Record<CliProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  lmstudio: 'LM Studio',
  deepagents: 'Deep Agents',
}

const PROVIDER_NOTES: Record<CliProvider, string> = {
  claude: 'Anthropic subscription · quota tracked',
  codex: 'ChatGPT Codex · quota tracked',
  gemini: 'Google Gemini · no quota tracking',
  lmstudio: 'Local model runner · free, always available',
  deepagents: 'Agentic local loop · LM Studio or Ollama',
}

const MODEL_TIERS = ['fast', 'normal', 'smart'] as const

const QUOTA_PROVIDERS: CliProvider[] = ['claude', 'codex']

interface QuotaSummary {
  fiveHour: number
  sevenDay: number | null
  blockedNow: boolean
}

export interface CliTabSettings {
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
  lmstudio_model: string
  default_model: string
  permission_mode: string
  base_prompt: string
  budget_block_runs_enabled: string
  budget_block_on_weekly_pace_enabled: string
  budget_block_at_pct: string
  budget_warn_at_pct: string
  [key: string]: string
}

function clampPct(raw: string): string {
  const n = parseInt(raw, 10)
  if (isNaN(n)) return '0'
  return String(Math.max(0, Math.min(100, n)))
}

function utilColor(pct: number, warn: number, block: number): string {
  if (pct >= block) return 'text-status-error'
  if (pct >= warn) return 'text-status-warning'
  return 'text-status-success'
}

function providerBinLabel(provider: CliProvider): string {
  if (provider === 'lmstudio') return 'LM Studio base URL override'
  if (provider === 'deepagents') return 'Deep Agents Code executable override'
  return provider === 'claude' ? 'Underlying Claude executable' : `${PROVIDER_LABELS[provider]} executable override`
}

export function CliTab({
  settings,
  onChange,
}: {
  settings: CliTabSettings
  onChange: (key: string, value: string) => void
}) {
  // Mirror the server-side fallback so an unsaved setting still shows a
  // sensible initial state (claude on, others off).
  const parsedEnabled = parseEnabledProviders(settings.cli_enabled_providers)
  const enabled: CliProvider[] = parsedEnabled.length > 0 ? parsedEnabled : ['claude']
  const enabledSet = new Set<CliProvider>(enabled)
  const blockEnabled = settings.budget_block_runs_enabled === 'true'
  const weeklyPaceEnabled = settings.budget_block_on_weekly_pace_enabled !== 'false'
  const warnAt = parseInt(settings.budget_warn_at_pct || '80', 10) || 80
  const blockAt = parseInt(settings.budget_block_at_pct || '95', 10) || 95

  // Live quota for each tracked CLI (claude / codex). The endpoint already
  // caches per-provider, so polling every 30s is cheap.
  const [quota, setQuota] = useState<Partial<Record<CliProvider, QuotaSummary>>>({})
  useEffect(() => {
    let cancelled = false
    async function load() {
      const enabledQuotaProviders = QUOTA_PROVIDERS.filter((p): p is 'claude' | 'codex' => enabledSet.has(p))
      const out: Partial<Record<CliProvider, QuotaSummary>> = {}
      await Promise.all(enabledQuotaProviders.map(async (p) => {
        const result = await loadQuotaSnapshot(p)
        if (!result.available || cancelled) return
        const fiveHour = Number(result.snapshot.fiveHour.utilization ?? 0)
        const sevenDay = result.snapshot.sevenDay?.utilization != null ? Number(result.snapshot.sevenDay.utilization) : null
        out[p] = { fiveHour, sevenDay, blockedNow: blockEnabled && fiveHour >= blockAt }
      }))
      if (!cancelled) setQuota(out)
    }
    load()
    const t = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [enabled.join(','), blockEnabled, blockAt])

  const toggleProvider = (provider: CliProvider, checked: boolean) => {
    if (!checked && enabled.length === 1 && enabled[0] === provider) return
    const next = checked ? [...enabled, provider] : enabled.filter((p) => p !== provider)
    onChange('cli_enabled_providers', encodeEnabledProviders(next))
  }

  return (
    <section className="space-y-3">
      {/* Enabled CLIs — single panel with inline quota chip per row.
          Disabled rows collapse to a single line; enabled rows expand to show
          per-CLI details (binary path override, lmstudio model id). */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Enabled CLIs</h3>
            <p className="text-xs text-text-tertiary mt-0.5">
              TamTam picks the enabled CLI with the most remaining quota for each top-level run; pipeline children inherit their parent.
            </p>
          </div>
        </div>
        <div className="divide-y divide-border/60">
          {CLI_PROVIDERS.map((provider) => {
            const isEnabled = enabledSet.has(provider)
            const isLastEnabled = isEnabled && enabled.length === 1
            const summary = quota[provider]
            return (
              <div key={provider} className={`px-5 py-3 ${isEnabled ? '' : 'opacity-60'}`}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    disabled={isLastEnabled}
                    onChange={(e) => toggleProvider(provider, e.target.checked)}
                    className="w-4 h-4 accent-accent rounded shrink-0 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0 flex items-baseline gap-3">
                    <div className="font-medium text-sm text-text-primary w-24 shrink-0">{PROVIDER_LABELS[provider]}</div>
                    <div className="text-xs text-text-tertiary truncate">{PROVIDER_NOTES[provider]}</div>
                  </div>
                  {summary && (
                    <div className="text-xs font-mono shrink-0 flex items-center gap-2">
                      <span className={utilColor(summary.fiveHour, warnAt, blockAt)}>
                        5h {summary.fiveHour.toFixed(0)}%
                      </span>
                      {summary.sevenDay != null && (
                        <span className={`${utilColor(summary.sevenDay, warnAt, blockAt)} hidden md:inline`}>
                          · 7d {summary.sevenDay.toFixed(0)}%
                        </span>
                      )}
                      {summary.blockedNow && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-status-error/15 text-status-error uppercase tracking-wide">
                          blocked
                        </span>
                      )}
                    </div>
                  )}
                  {!summary && (provider === 'gemini' || provider === 'lmstudio' || provider === 'deepagents') && isEnabled && (
                    <span className="text-xs text-text-tertiary shrink-0">always selectable</span>
                  )}
                </label>

                {isEnabled && (
                  <div className="mt-3 ml-7 grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="block text-xs text-text-tertiary mb-1">{providerBinLabel(provider)}</label>
                      <input
                        type="text"
                        value={settings[`cli_bin_${provider}`] ?? ''}
                        placeholder={provider === 'lmstudio' ? 'http://127.0.0.1:1234' : provider}
                        onChange={(e) => onChange(`cli_bin_${provider}`, e.target.value)}
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-tertiary mb-1">Default model tier for {PROVIDER_LABELS[provider]}</label>
                      <select
                        value={settings[`cli_default_model_${provider}`] || 'normal'}
                        onChange={(e) => onChange(`cli_default_model_${provider}`, e.target.value)}
                        className={SELECT_CLASS}
                      >
                        {MODEL_TIERS.map((tier) => (
                          <option key={tier} value={tier}>{tier}</option>
                        ))}
                      </select>
                    </div>
                    {provider === 'lmstudio' && (
                      <div className="md:col-span-2">
                        <label className="block text-xs text-text-tertiary mb-1">LM Studio model id</label>
                        <input
                          type="text"
                          value={settings.lmstudio_model ?? ''}
                          placeholder="qwen2.5-coder-14b-instruct"
                          onChange={(e) => onChange('lmstudio_model', e.target.value)}
                          className={INPUT_CLASS}
                        />
                      </div>
                    )}
                    {provider === 'deepagents' && (
                      <div className="md:col-span-2 grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="block text-xs text-text-tertiary mb-1">Local backend</label>
                          <select
                            value={settings.cli_deepagents_backend || 'lmstudio'}
                            onChange={(e) => onChange('cli_deepagents_backend', e.target.value)}
                            className={SELECT_CLASS}
                          >
                            <option value="lmstudio">LM Studio</option>
                            <option value="ollama">Ollama</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-text-tertiary mb-1">Backend base URL</label>
                          <input
                            type="text"
                            value={settings.cli_deepagents_base_url ?? ''}
                            placeholder={settings.cli_deepagents_backend === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234'}
                            onChange={(e) => onChange('cli_deepagents_base_url', e.target.value)}
                            className={INPUT_CLASS}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {isEnabled && provider === 'claude' && (
                  <div className="mt-2 ml-7 text-[11px] text-text-tertiary">
                    TamTam still launches the bundled Claude shim so `fast` / `normal` / `smart` tiers work; this path is forwarded as `CLAUDE_BIN`.
                  </div>
                )}
                {isEnabled && provider === 'codex' && (
                  <div className="mt-2 ml-7 text-[11px] text-text-tertiary">
                    TamTam still launches the bundled Codex shim; this path is forwarded as `CODEX_BIN`.
                  </div>
                )}
                {isEnabled && provider === 'gemini' && (
                  <div className="mt-2 ml-7 text-[11px] text-text-tertiary">
                    TamTam still launches the bundled Gemini shim; this path is forwarded as `GEMINI_BIN`.
                  </div>
                )}
                {isEnabled && provider === 'lmstudio' && (
                  <div className="mt-2 ml-7 text-[11px] text-text-tertiary">
                    TamTam still launches the bundled LM Studio shim; this field overrides `LMSTUDIO_BASE_URL` when you point it at a remote server URL.
                  </div>
                )}
                {isEnabled && provider === 'deepagents' && (
                  <div className="mt-2 ml-7 text-[11px] text-text-tertiary">
                    TamTam launches the bundled Deep Agents shim; this provider runs the Deep Agents Code CLI against the selected local backend.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Shared run settings — terminal preselect, permission mode, base prompt. */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">Shared defaults</h3>
          <p className="text-xs text-text-tertiary mt-0.5">Terminal preselect, permission mode, and base prompt shared across CLIs</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Default model tier</label>
              <select
                value={settings.default_model || 'fast'}
                onChange={(e) => onChange('default_model', e.target.value)}
                className={SELECT_CLASS}
              >
                {MODEL_TIERS.map((tier) => (
                  <option key={tier} value={tier}>{tier}</option>
                ))}
              </select>
              <p className="text-xs text-text-tertiary mt-1">Used as the terminal UI preselect. Background launchers use the per-provider defaults above when no explicit model is supplied.</p>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Permission mode</label>
              <select
                value={settings.permission_mode || 'acceptEdits'}
                onChange={(e) => onChange('permission_mode', e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="bypassPermissions">bypassPermissions</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="auto">auto</option>
                <option value="dontAsk">dontAsk</option>
                <option value="default">default</option>
                <option value="plan">plan</option>
              </select>
              {settings.permission_mode === 'auto' && (
                <div className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning" role="alert">
                  <span className="font-medium">Warning:</span> auto preserves provider-native approval behavior. On CLIs that still prompt for write approval in headless mode, unattended jobs can block. Prefer acceptEdits for background runs.
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Base prompt prepended to every run</label>
            <textarea
              value={settings.base_prompt ?? ''}
              onChange={(e) => onChange('base_prompt', e.target.value)}
              className="w-full min-h-[72px] px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono"
            />
          </div>
        </div>
      </div>

      {/* Budget gate — controls how the per-row "blocked" badge maps to picker behaviour. */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">Budget gate</h3>
          <p className="text-xs text-text-tertiary mt-0.5">Skip enabled CLIs whose 5-hour quota window is close to exhausted</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={blockEnabled}
              onChange={(e) => onChange('budget_block_runs_enabled', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-accent rounded shrink-0 cursor-pointer"
            />
            <div className="flex-1 min-w-0 flex items-baseline gap-1.5 flex-wrap">
              <span className="font-medium text-sm text-text-primary shrink-0">Skip CLIs over budget</span>
              <span className="text-xs text-text-tertiary">If every enabled CLI is over budget the run is rejected with a 429.</span>
            </div>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={weeklyPaceEnabled}
              onChange={(e) => onChange('budget_block_on_weekly_pace_enabled', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-accent rounded shrink-0 cursor-pointer"
              disabled={!blockEnabled}
            />
            <div className="flex-1 min-w-0 flex items-baseline gap-1.5 flex-wrap">
              <span className="font-medium text-sm text-text-primary shrink-0">Include weekly pace</span>
              <span className="text-xs text-text-tertiary">Treat the 7-day pace window as part of the hard gate.</span>
            </div>
          </label>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Block threshold (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={settings.budget_block_at_pct}
                onChange={(e) => onChange('budget_block_at_pct', clampPct(e.target.value))}
                className={INPUT_CLASS}
                disabled={!blockEnabled}
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Warn threshold (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={settings.budget_warn_at_pct}
                onChange={(e) => onChange('budget_warn_at_pct', clampPct(e.target.value))}
                className={INPUT_CLASS}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
