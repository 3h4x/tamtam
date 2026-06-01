'use client'

const SCHEDULES = ['15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h', '3d', '7d', '30d']

/**
 * Schedule / Enabled / Boostable control strip for the agent editor. Extracted
 * from AgentEditor to keep that file under the component size cap.
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
        <select
          id="agent-schedule"
          className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-bg-primary border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          disabled={isSystemAgent}
          title={isSystemAgent ? 'Set in Settings → Retrieval' : undefined}
        >
          <option value="">Manual</option>
          {SCHEDULES.map(s => <option key={s} value={s}>every {s}</option>)}
        </select>
      </div>
      <div className="w-px h-4 bg-border shrink-0" />
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => setEnabled(!enabled)}
        className="flex items-center gap-2 cursor-pointer shrink-0"
      >
        <div className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-150 ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </div>
        <span className="text-xs text-text-secondary font-medium">Enabled</span>
      </button>
      <div className="w-px h-4 bg-border shrink-0" />
      <button
        type="button"
        role="switch"
        aria-checked={boostable}
        onClick={() => setBoostable(!boostable)}
        disabled={isSystemAgent}
        className="flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        title="When off, the orchestrator never picks this agent for catch-up boost fires — it only runs on its own schedule. Use for blog/social-post style agents."
      >
        <div className={`relative w-9 h-5 rounded-full transition-colors ${boostable ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-150 ${boostable ? 'left-[18px]' : 'left-0.5'}`} />
        </div>
        <span className="text-xs text-text-secondary font-medium">Boostable</span>
      </button>
    </div>
  )
}
