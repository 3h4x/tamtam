'use client'

import { QuotaWidget } from '@/components/QuotaWidget'

export interface BudgetSettings {
  budget_block_runs_enabled: string
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
  const warnAt = parseInt(settings.budget_warn_at_pct || '80', 10) || 80
  const blockAt = parseInt(settings.budget_block_at_pct || '95', 10) || 95

  return (
    <section className="space-y-4">
      <QuotaWidget warnAt={warnAt} blockAt={blockAt} refreshSeconds={30} />

      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Subscription Budget</h3>
          <p className="text-xs text-text-tertiary">
            Pause new pipeline runs when the selected agent subscription quota is close to exhausted
          </p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="flex items-start gap-3 p-3 rounded-lg hover:bg-bg-tertiary/50 cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onChange('budget_block_runs_enabled', e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-accent rounded mt-0.5 shrink-0 cursor-pointer"
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-text-primary">Block runs over budget</div>
              <div className="text-xs text-text-tertiary">
                When enabled, agent runs, terminal runs, and the release pipeline are refused once the
                5-hour window crosses the block threshold.
              </div>
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
