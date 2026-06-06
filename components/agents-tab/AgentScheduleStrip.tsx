'use client'

import { Select } from '@/components/ui/Select'
import { ToggleSwitch } from '@/components/ui/ToggleSwitch'

const SCHEDULES = ['15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h', '3d', '7d', '30d']

/**
 * Schedule / Enabled / Boostable control strip for the agent editor.
 */
export function AgentScheduleStrip({
  schedule,
  setSchedule,
  enabled,
  setEnabled,
  boostable,
  setBoostable,
  isSystemAgent,
}: {
  schedule: string
  setSchedule: (v: string) => void
  enabled: boolean
  setEnabled: (v: boolean) => void
  boostable: boolean
  setBoostable: (v: boolean) => void
  isSystemAgent: boolean
}) {
  return (
    <div className="flex items-center gap-4 px-3 py-2.5 rounded-lg bg-bg-secondary border border-border flex-wrap">
      <div className="flex items-center gap-2 flex-1 min-w-[160px]">
        <span className="text-xs text-text-tertiary whitespace-nowrap font-medium">Schedule</span>
        <Select
          id="agent-schedule"
          size="compact"
          focusRing="strong"
          className="flex-1 min-w-0 disabled:opacity-60 disabled:cursor-not-allowed"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          disabled={isSystemAgent}
          title={isSystemAgent ? 'Set in Settings → Retrieval' : undefined}
        >
          <option value="">Manual</option>
          {SCHEDULES.map(s => <option key={s} value={s}>every {s}</option>)}
        </Select>
      </div>
      <div className="w-px h-4 bg-border shrink-0" />
      <ToggleSwitch checked={enabled} onChange={setEnabled} label="Enabled" />
      <div className="w-px h-4 bg-border shrink-0" />
      <ToggleSwitch
        checked={boostable}
        onChange={setBoostable}
        label="Boostable"
        disabled={isSystemAgent}
        title="When off, the orchestrator never picks this agent for catch-up boost fires — it only runs on its own schedule. Use for blog/social-post style agents."
      />
    </div>
  )
}
