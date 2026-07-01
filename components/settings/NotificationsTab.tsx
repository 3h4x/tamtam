'use client'

import { useState } from 'react'
import { errMsg } from '@/lib/shared/types'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Input } from '@/components/ui/Input'

export interface NotificationsSettings {
  notification_webhook_url: string
  notification_webhook_secret: string
  notification_on_release_success: string
  notification_on_release_fail: string
  notification_on_release_aborted: string
  notification_on_fix_loop_exhausted: string
  notification_on_review_do_not_ship: string
  notification_on_agent_run_fail: string
  notification_on_budget_blocked: string
  notification_on_budget_exceeded: string
  notification_throttle_window_seconds: string
  notification_throttle_overrides: string
  [key: string]: string
}

const EVENT_TOGGLES = [
  { key: 'notification_on_release_success' as const, label: 'Release Success', description: 'When a release pipeline completes successfully' },
  { key: 'notification_on_release_fail' as const, label: 'Release Failure', description: 'When a release pipeline fails' },
  { key: 'notification_on_release_aborted' as const, label: 'Release Aborted', description: 'When a release pipeline is aborted mid-run' },
  { key: 'notification_on_fix_loop_exhausted' as const, label: 'Fix Loop Exhausted', description: 'When automated recovery budget is exhausted (review/test/commit/push fix attempts)' },
  { key: 'notification_on_review_do_not_ship' as const, label: 'Review: Do Not Ship', description: 'When a review verdict is "DO NOT SHIP"' },
  { key: 'notification_on_agent_run_fail' as const, label: 'Agent Run Failure', description: 'When an agent run fails' },
  { key: 'notification_on_budget_blocked' as const, label: 'Budget Blocked', description: 'When a run is refused because the active provider crosses the configured subscription budget threshold' },
  { key: 'notification_on_budget_exceeded' as const, label: 'Project Budget Exceeded', description: 'When a project daily or per-release spend cap blocks agent or release automation' },
  { key: 'notification_on_circuit_breaker_tripped' as const, label: 'Circuit Breaker Tripped', description: 'When repeated run failures auto-pause a project (see Pipeline → Runaway Guards)' },
]

export function NotificationsTab({
  settings,
  onChange,
}: {
  settings: NotificationsSettings
  onChange: (key: string, value: string) => void
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

  return (
    <section className="space-y-4">
      {/* Webhook Configuration */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Webhook Configuration</h3>
          <p className="text-xs text-text-tertiary">Configure outbound notifications for release pipeline events</p>
        </div>
        <form
          className="px-5 py-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleTestNotification()
          }}
        >
          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Webhook URL</label>
            <Input
              type="text"
              value={settings.notification_webhook_url}
              onChange={(e) => onChange('notification_webhook_url', e.target.value)}
              placeholder="https://hooks.slack.com/services/... or https://discordapp.com/api/webhooks/... or any webhook endpoint"
              className="placeholder:text-text-tertiary"
            />
            <p className="text-xs text-text-tertiary mt-1.5">Supports Slack, Discord, ntfy, and generic JSON POST webhooks</p>
          </div>

          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Webhook Secret (Optional)</label>
            <Input
              type="password"
              value={settings.notification_webhook_secret}
              onChange={(e) => onChange('notification_webhook_secret', e.target.value)}
              placeholder="Secret for HMAC-SHA256 signature verification"
              className="placeholder:text-text-tertiary"
            />
            <p className="text-xs text-text-tertiary mt-1.5">If set, payloads will be signed with <code className="bg-bg-tertiary px-1 rounded">X-TamTam-Signature</code> header</p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button
              type="submit"
              variant={testSuccess ? 'success-solid' : 'solid'}
              disabled={testSending || !settings.notification_webhook_url}
              disabledCursor={testSending ? 'wait' : 'not-allowed'}
            >
              {testSending ? 'Sending…' : testSuccess ? 'Sent!' : 'Send Test'}
            </Button>
            {testError && (
              <ErrorCallout padding="sm" radius="md" className="text-sm">
                {testError}
              </ErrorCallout>
            )}
          </div>
        </form>
      </div>

      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Throttle</h3>
          <p className="text-xs text-text-tertiary">Suppress repeated alerts with the same event, project, and agent</p>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Window Seconds</label>
            <Input
              type="number"
              min="1"
              value={settings.notification_throttle_window_seconds}
              onChange={(e) => onChange('notification_throttle_window_seconds', e.target.value)}
              className="placeholder:text-text-tertiary"
            />
            <p className="text-xs text-text-tertiary mt-1.5">Default 900. Repeated matching alerts are counted, then included on the next send after the window.</p>
          </div>
          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5">Override JSON</label>
            <Input
              type="text"
              value={settings.notification_throttle_overrides}
              onChange={(e) => onChange('notification_throttle_overrides', e.target.value)}
              className="placeholder:text-text-tertiary"
            />
            <p className="text-xs text-text-tertiary mt-1.5">Set an event to 0 to always send it.</p>
          </div>
        </div>
      </div>

      {/* Event Toggles */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Notification Events</h3>
          <p className="text-xs text-text-tertiary">Choose which events trigger notifications</p>
        </div>
        <div className="px-4 py-1 divide-y divide-border/40">
          {EVENT_TOGGLES.map(({ key, label, description }) => (
            <label
              key={key}
              className="flex items-center gap-2.5 py-2 px-1 -mx-1 rounded hover:bg-bg-tertiary/40 cursor-pointer transition-colors"
            >
              <Checkbox
                variant="native"
                checked={settings[key] === 'true'}
                onChange={(e) => onChange(key, e.target.checked ? 'true' : 'false')}
              />
              <div className="flex-1 min-w-0 flex items-baseline gap-1.5 flex-wrap">
                <span className="font-medium text-sm text-text-primary shrink-0">{label}</span>
                <span className="text-xs text-text-tertiary">{description}</span>
              </div>
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}
