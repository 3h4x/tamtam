'use client'

import { useState } from 'react'
import type { SettingsMap } from '@/components/settings/settings-page-config'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Input } from '@/components/ui/Input'

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function AuthTab({
  configured,
  onConfiguredChange,
}: {
  configured: boolean
  onConfiguredChange: (value: SettingsMap['auth_token_configured']) => void
}) {
  const [generated, setGenerated] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function patchAuthToken(value: string | null) {
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: value }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }
      const data = await res.json().catch(() => ({}))
      onConfiguredChange(data.settings?.auth_token_configured === 'true' ? 'true' : 'false')
      setMessage(value ? 'Auth token rotated.' : 'Auth disabled.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save auth settings')
    } finally {
      setSaving(false)
    }
  }

  async function generateAndSave() {
    const token = randomToken()
    setGenerated(token)
    await patchAuthToken(token)
  }

  async function disableAuth() {
    setGenerated('')
    await patchAuthToken(null)
  }

  return (
    <section className="rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold text-text-primary">Shared Token</h3>
        <p className="mt-1 text-xs text-text-tertiary">Bearer token and httpOnly cookie auth for TamTam HTTP entrypoints.</p>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${configured ? 'bg-status-success' : 'bg-status-warning'}`} />
          <span className="text-sm text-text-primary">{configured ? 'Authentication is enabled' : 'Authentication is disabled'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={generateAndSave} disabled={saving}>
            {configured ? 'Rotate token' : 'Generate token'}
          </Button>
          {configured && (
            <Button type="button" variant="ghost" onClick={disableAuth} disabled={saving}>
              Disable auth
            </Button>
          )}
        </div>
        {generated && (
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">New token</label>
            <Input value={generated} readOnly />
            <p className="mt-1 text-xs text-text-tertiary">Shown once. Store it before leaving this page.</p>
          </div>
        )}
        {message && <p className="text-sm text-status-success">{message}</p>}
        {error && (
          <ErrorCallout padding="none" preWrap={false} className="border-0 bg-transparent text-sm">
            {error}
          </ErrorCallout>
        )}
      </div>
    </section>
  )
}
