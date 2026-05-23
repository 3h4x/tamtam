'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AgentsEmptyState, AgentsLoadingState } from '@/components/agents/AgentStates'
import { StandardTabs, type StandardTabItem } from '@/components/ui/StandardTabs'
import { fetchAgents } from '@/lib/client-api'
import type { Agent } from '@/lib/client-api'

interface SchedulerEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  nextFireMs: number
  lastFireMs: number | null
  fireCount: number
  errorCount: number
  lastError: string | null
}

function formatRelativeMs(ms: number): string {
  const diffMs = ms - Date.now()
  if (diffMs <= 0) return 'soon'
  const totalSec = Math.floor(diffMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${totalSec}s`
}

function formatAgoMs(ms: number): string {
  const diffMs = Date.now() - ms
  if (diffMs < 0) return 'just now'
  const totalSec = Math.floor(diffMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m ago`
  if (m > 0) return `${m}m ago`
  return `${totalSec}s ago`
}

type AgentState = 'active' | 'on-demand' | 'disabled' | 'unscheduled'
type AgentFilter = 'all' | 'active' | 'on-demand' | 'disabled'

function agentState(agent: Agent, schedEntry: SchedulerEntry | undefined): AgentState {
  if (!agent.enabled) return 'disabled'
  if (!agent.schedule) return 'on-demand'
  if (schedEntry) return 'active'
  return 'unscheduled'
}

const STATE_STYLE: Record<AgentState, string> = {
  active: 'bg-status-success/15 text-status-success',
  'on-demand': 'bg-accent/10 text-accent',
  disabled: 'bg-bg-tertiary text-text-tertiary',
  unscheduled: 'bg-status-warning/15 text-status-warning',
}

const STATE_LABEL: Record<AgentState, string> = {
  active: 'active',
  'on-demand': 'on-demand',
  disabled: 'disabled',
  unscheduled: 'unscheduled',
}

export function AgentsPage() {
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[]>([])
  const [schedulerMap, setSchedulerMap] = useState<Map<string, SchedulerEntry>>(new Map())
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<AgentFilter>('all')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const [{ agents: allAgents }, health] = await Promise.all([
          fetchAgents(undefined, { fields: 'summary' }),
          fetch('/api/agents/scheduler-health').then(r => r.ok ? r.json() : null).catch(() => null),
        ])
        if (active) {
          setAgents(allAgents)
          if (health?.internal?.entries) {
            const map = new Map<string, SchedulerEntry>()
            for (const e of health.internal.entries as SchedulerEntry[]) {
              map.set(e.agentId, e)
            }
            setSchedulerMap(map)
          }
          setLoading(false)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  // Single pass: was 5 separate .filter() loops (one for `filtered`, four
  // for counts), each calling getState(a) → schedulerMap.get(a.id). With N
  // agents that's 5N getState calls; now N.
  const filtered: Agent[] = []
  const stateByAgentId = new Map<string, AgentState>()
  let activeCount = 0
  let onDemandCount = 0
  let disabledCount = 0
  let unscheduledCount = 0
  for (const a of agents) {
    const state = agentState(a, schedulerMap.get(a.id))
    stateByAgentId.set(a.id, state)
    if (state === 'active') activeCount++
    else if (state === 'on-demand') onDemandCount++
    else if (state === 'disabled') disabledCount++
    else unscheduledCount++
    if (filter === 'all' || state === filter) filtered.push(a)
  }

  const filterTabs: StandardTabItem<AgentFilter>[] = ([
    ['all', 'All', agents.length],
    ['active', 'Active', activeCount],
    ['on-demand', 'On-demand', onDemandCount],
    ['disabled', 'Disabled', disabledCount],
  ] as const).map(([id, label, count]) => ({
    id,
    label: (
      <>
        {label} <span className="tabular-nums opacity-70">({count})</span>
      </>
    ),
  }))

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-xl font-semibold text-text-primary">Agents</h2>
        <StandardTabs
          items={filterTabs}
          activeTab={filter}
          ariaLabel="Agent filters"
          onChange={setFilter}
        />
      </div>

      {loading ? (
        <AgentsLoadingState rows={6} />
      ) : filtered.length === 0 ? (
        <AgentsEmptyState
          title={
            filter === 'all'
              ? 'No agents configured yet'
              : filter === 'active'
                ? 'No active scheduled agents'
                : filter === 'on-demand'
                  ? 'No on-demand agents'
                  : 'No disabled agents'
          }
          description={
            filter === 'all'
              ? 'Agents appear here after they are created from a project. Use them for scheduled checks, recurring reviews, or on-demand tasks.'
              : `There are ${agents.length} total agents in view, but none match the ${filter} filter right now.`
          }
          meta={
            filter === 'active' && unscheduledCount > 0
              ? `${unscheduledCount} enabled scheduled agent${unscheduledCount === 1 ? '' : 's'} are not registered in the scheduler yet.`
              : filter === 'all'
                ? 'Create agents from a project Agents tab, then use skills as building blocks for prompt setup.'
                : undefined
          }
          stats={[
            { label: 'total', value: String(agents.length), mono: true },
            { label: 'active', value: String(activeCount), mono: true, tone: 'success' },
            { label: 'on-demand', value: String(onDemandCount), mono: true, tone: 'accent' },
            { label: 'disabled', value: String(disabledCount), mono: true, tone: 'muted' },
          ]}
          primaryAction={
            filter === 'all'
              ? { label: 'Open skills', href: '/skills', variant: 'primary' }
              : { label: 'Show all agents', onClick: () => setFilter('all') }
          }
          secondaryAction={
            filter === 'all'
              ? { label: 'View projects', href: '/' }
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-xs text-text-secondary uppercase tracking-wider border-b border-border">
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-4 py-2 font-medium">Schedule</th>
                <th className="px-4 py-2 font-medium">Next Fire</th>
                <th className="px-4 py-2 font-medium">Last Fire</th>
                <th className="px-4 py-2 font-medium text-center">Fires</th>
                <th className="px-4 py-2 font-medium text-center">Errors</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((agent) => {
                const schedEntry = schedulerMap.get(agent.id)
                const state = stateByAgentId.get(agent.id) ?? agentState(agent, schedEntry)
                const accentBorder =
                  state === 'active' ? 'border-l-status-success/40' :
                  state === 'unscheduled' ? 'border-l-status-warning/60' :
                  state === 'disabled' ? 'border-l-transparent' :
                  'border-l-accent/30'
                return (
                  <tr
                    key={agent.id}
                    className={`border-t border-border hover:bg-bg-secondary/50 cursor-pointer border-l-2 ${accentBorder}`}
                    onClick={() => router.push(`/project/${encodeURIComponent(agent.project)}`)}
                  >
                    <td className="px-4 py-2">
                      <span
                        className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATE_STYLE[state]}`}
                        title={state === 'unscheduled' ? 'Scheduled but not registered in internal scheduler' : undefined}
                      >
                        {STATE_LABEL[state]}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-medium text-text-primary" data-private>{agent.project}</td>
                    <td className="px-4 py-2 text-text-secondary font-mono text-xs" data-private>
                      {agent.name}
                      {agent.source === 'file' && (
                        <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary border border-border">file</span>
                      )}
                      {agent.kind === 'system' && (
                        <span
                          className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-accent/10 text-accent border border-accent/30"
                          title="Built-in system agent — auto-managed by TamTam"
                        >system</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-text-tertiary text-xs font-mono">{agent.model}</td>
                    <td className="px-4 py-2 text-text-secondary font-mono text-xs tabular-nums">
                      {agent.schedule || <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs tabular-nums">
                      {schedEntry ? (() => {
                        const isOverdue = schedEntry.nextFireMs < Date.now() - 30_000
                        const hasErrors = schedEntry.errorCount > 0
                        const tone = hasErrors ? 'text-status-warning' : isOverdue ? 'text-status-warning' : 'text-text-secondary'
                        const label = isOverdue ? 'overdue' : `in ${formatRelativeMs(schedEntry.nextFireMs)}`
                        const hint = hasErrors
                          ? `${schedEntry.errorCount} error(s): ${schedEntry.lastError ?? ''}`
                          : `${schedEntry.fireCount} fire(s) · next ${new Date(schedEntry.nextFireMs).toLocaleTimeString()}`
                        return <span className={`font-mono ${tone}`} title={hint}>{label}</span>
                      })() : (
                        <span className="text-text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-text-tertiary text-xs tabular-nums font-mono">
                      {schedEntry
                        ? schedEntry.lastFireMs
                          ? formatAgoMs(schedEntry.lastFireMs)
                          : <span className="text-text-tertiary/50 italic">never fired</span>
                        : <span>—</span>}
                    </td>
                    <td className="px-4 py-2 text-center tabular-nums text-xs text-text-secondary">
                      {schedEntry ? schedEntry.fireCount : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2 text-center tabular-nums text-xs">
                      {schedEntry
                        ? schedEntry.errorCount > 0
                          ? <span className="text-status-warning font-medium" title={schedEntry.lastError ?? ''}>{schedEntry.errorCount}</span>
                          : <span className="text-text-tertiary">0</span>
                        : <span className="text-text-tertiary">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
