'use client'

import { useState } from 'react'
import { errMsg } from '@/lib/shared/types'
import type { SettingsMap } from '@/components/settings/settings-page-config'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { ErrorCallout } from '@/components/ui/ErrorCallout'

export function DatabaseTab({
  settings,
  onChange,
}: {
  settings: SettingsMap
  onChange: (key: keyof SettingsMap, value: string) => void
}) {
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

  return (
    <section className="bg-bg-secondary rounded-lg border border-border">
      <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
        <h3 className="text-sm font-semibold text-text-primary">Database Backup</h3>
        <p className="text-xs text-text-tertiary">Automatic Postgres backups + manual snapshot trigger</p>
      </div>
      <div className="px-5 py-4 grid grid-cols-2 gap-4">
        <div>
          <label className="block font-medium text-sm text-text-primary mb-1.5">Auto-backup</label>
          <Select
            value={settings.db_backup_enabled || 'true'}
            onChange={(e) => onChange('db_backup_enabled', e.target.value)}
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </Select>
          <p className="text-xs text-text-tertiary mt-1.5">Runs in the background on the cron interval below.</p>
        </div>
        <div>
          <label className="block font-medium text-sm text-text-primary mb-1.5">Backup Interval (minutes)</label>
          <Input
            type="number"
            min={1}
            step={1}
            value={settings.db_backup_interval_minutes || '15'}
            onChange={(e) => onChange('db_backup_interval_minutes', e.target.value)}
          />
          <p className="text-xs text-text-tertiary mt-1.5">How often the auto-backup fires. Default 15.</p>
        </div>
        <div>
          <label className="block font-medium text-sm text-text-primary mb-1.5">Recent backups to keep</label>
          <Input
            type="number"
            min={0}
            step={1}
            value={settings.backup_retention_count || '14'}
            onChange={(e) => onChange('backup_retention_count', e.target.value)}
          />
          <p className="text-xs text-text-tertiary mt-1.5">Newest N pgdump files retained after each backup.</p>
        </div>
        <div>
          <label className="block font-medium text-sm text-text-primary mb-1.5">Weekly backups to keep</label>
          <Input
            type="number"
            min={0}
            step={1}
            value={settings.backup_retention_weekly_count || '8'}
            onChange={(e) => onChange('backup_retention_weekly_count', e.target.value)}
          />
          <p className="text-xs text-text-tertiary mt-1.5">One older backup per week kept beyond the recent N.</p>
        </div>
      </div>
      <div className="px-5 py-4 border-t border-border flex items-center gap-3">
        <Button
          onClick={handleBackup}
          disabled={backingUp}
          variant={backupResult ? 'success-solid' : 'solid'}
          disabledCursor={backingUp ? 'wait' : 'not-allowed'}
          className={`px-4 py-1.5 rounded-lg font-semibold ${
            backupResult ? 'hover:bg-status-success' : ''
          } ${backingUp ? 'opacity-50 cursor-wait disabled:opacity-50' : ''}`}
        >
          {backingUp ? 'Backing up…' : backupResult ? 'Done!' : 'Manual Backup Now'}
        </Button>
        {backupResult && (
          <span className="font-mono text-xs text-text-secondary">{backupResult.filename}</span>
        )}
        {backupError && (
          <ErrorCallout padding="sm" radius="md" className="text-sm">{backupError}</ErrorCallout>
        )}
      </div>
    </section>
  )
}
