'use client'

import { QuotaWidget } from '@/components/QuotaWidget'
import {
  BUDGET_SUBSCRIPTION_PROVIDERS,
  encodeBudgetSubscriptionProviders,
  normalizeBudgetSubscriptionProviders,
  type BudgetSubscriptionProvider,
} from '@/lib/usage/subscription-providers'

export interface BudgetSettings {
  budget_block_runs_enabled: string
  budget_subscription_providers: string
  budget_block_at_pct: string
  budget_warn_at_pct: string
  [key: string]: string
}

const INPUT_CLASS =
  'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono'

function clampPct(raw: string): string {
  const n = parseInt(raw, 10)
  if (isNaN(n)) return '0'
  return String(Math.max(0, Math.min(100, n)))
}

export function BudgetTab({
  settings,
  onChange,
}: {
  settings: BudgetSettings
  onChange: (key: string, value: string) => void
}) {
  const enabled = settings.budget_block_runs_enabled === 'true'
  const providers = normalizeBudgetSubscriptionProviders(settings.budget_subscription_providers)
  const warnAt = parseInt(settings.budget_warn_at_pct || '80', 10) || 80
  const blockAt = parseInt(settings.budget_block_at_pct || '95', 10) || 95

  function toggleProvider(provider: BudgetSubscriptionProvider, checked: boolean) {
    if (!checked && providers.length === 1 && providers.includes(provider)) return
    const next = checked
      ? [...providers, provider]
      : providers.filter((value) => value !== provider)
    onChange('budget_subscription_providers', encodeBudgetSubscriptionProviders(next))
  }

  return (
    <section className="space-y-4">
      <QuotaWidget providers={providers} warnAt={warnAt} blockAt={blockAt} refreshSeconds={30} />

      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Subscription Budget</h3>
          <p className="text-xs text-text-tertiary">
            Pause new pipeline runs when the selected agent subscription quota is close to exhausted
          </p>
        </div>
        <div className="px-5 py-3 space-y-3">
          <div>
            <div className="font-medium text-sm text-text-primary mb-1.5">Tracked subscriptions</div>
            <div className="divide-y divide-border/40 -mx-1">
              {BUDGET_SUBSCRIPTION_PROVIDERS.map((provider) => (
                <label
                  key={provider}
                  className="flex items-center gap-2.5 py-2 px-1 rounded hover:bg-bg-tertiary/40 cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={providers.includes(provider)}
                    disabled={providers.length === 1 && providers.includes(provider)}
                    onChange={(e) => toggleProvider(provider, e.target.checked)}
                    className="w-4 h-4 accent-accent rounded shrink-0 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                    <span className="font-medium text-sm text-text-primary shrink-0">
                      {provider === 'claude' ? 'Claude' : 'Codex'}
                    </span>
                    <span className="text-xs text-text-tertiary">Show pace and quota state in Settings and Stats.</span>
                  </div>
                </label>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-1.5">
              These checkboxes control which subscriptions TamTam tracks in budget views — not which provider runs use.
            </p>
          </div>

          <label className="flex items-center gap-2.5 py-2 px-1 -mx-1 rounded hover:bg-bg-tertiary/40 cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onChange('budget_block_runs_enabled', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-accent rounded shrink-0 cursor-pointer"
            />
            <div className="flex-1 min-w-0 flex items-baseline gap-1.5 flex-wrap">
              <span className="font-medium text-sm text-text-primary shrink-0">Block runs over budget</span>
              <span className="text-xs text-text-tertiary">
                Refuse agent runs, terminal runs, and pipeline once the 5-hour window crosses the block threshold.
              </span>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-sm text-text-primary mb-1.5">Block threshold (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={settings.budget_block_at_pct}
                onChange={(e) => onChange('budget_block_at_pct', clampPct(e.target.value))}
                className={INPUT_CLASS}
                disabled={!enabled}
              />
              <p className="text-xs text-text-tertiary mt-1.5">
                Refuse new runs when 5h utilization reaches this percentage. Default 95.
              </p>
            </div>
            <div>
              <label className="block font-medium text-sm text-text-primary mb-1.5">Warn threshold (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={settings.budget_warn_at_pct}
                onChange={(e) => onChange('budget_warn_at_pct', clampPct(e.target.value))}
                className={INPUT_CLASS}
              />
              <p className="text-xs text-text-tertiary mt-1.5">
                Quota bar above turns yellow at this percentage. Cosmetic only. Default 80.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
