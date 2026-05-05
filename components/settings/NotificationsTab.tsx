'use client'

import { useState } from 'react'
import { errMsg } from '@/lib/shared/types'

export interface NotificationsSettings {
  notification_webhook_url: string
  notification_webhook_secret: string
  notification_on_release_success: string
  notification_on_release_fail: string
  notification_on_release_aborted: string
  notification_on_fix_loop_exhausted: string
  notification_on_review_do_not_ship: string
  notification_on_agent_run_fail: string
  [key: string]: string
}

const INPUT_CLASS = 'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono placeholder:text-text-tertiary'

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

  const eventToggles = [
    { key: 'notification_on_release_success' as const, label: 'Release Success', description: 'When a release pipeline completes successfully' },
    { key: 'notification_on_release_fail' as const, label: 'Release Failure', description: 'When a release pipeline fails' },
    { key: 'notification_on_release_aborted' as const, label: 'Release Aborted', description: 'When a release pipeline is aborted mid-run' },
    { key: 'notification_on_fix_loop_exhausted' as const, label: 'Fix Loop Exhausted', description: 'When automated recovery budget is exhausted (review/test retries or fix-push attempts)' },
    { key: 'notification_on_review_do_not_ship' as const, label: 'Review: Do Not Ship', description: 'When a review verdict is "DO NOT SHIP"' },
    { key: 'notification_on_agent_run_fail' as const, label: 'Agent Run Failure', description: 'When an agent run fails' },
    { key: 'notification_on_budget_blocked' as const, label: 'Budget Blocked', description: 'When a run is refused because the active provider crosses the configured subscription budget threshold' },
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
