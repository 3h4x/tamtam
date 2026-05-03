'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
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

function agentState(agent: Agent, schedEntry: SchedulerEntry | undefined): AgentState {
  if (!agent.enabled) return 'disabled'
  if (!agent.schedule) return 'on-demand'
  if (schedEntry) return 'active'
  return 'unscheduled'
}

export function AgentsPage() {
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[]>([])
  const [schedulerMap, setSchedulerMap] = useState<Map<string, SchedulerEntry>>(new Map())
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'active' | 'on-demand' | 'disabled'>('all')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const [{ agents: allAgents }, health] = await Promise.all([
          fetchAgents(),
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

  const getState = (a: Agent) => agentState(a, schedulerMap.get(a.id))

  const filtered = agents.filter((a) => {
    if (filter === 'all') return true
    return getState(a) === filter
  })

  const activeCount = agents.filter(a => getState(a) === 'active').length
  const onDemandCount = agents.filter(a => getState(a) === 'on-demand').length
  const disabledCount = agents.filter(a => getState(a) === 'disabled').length

  const stateStyle: Record<AgentState, string> = {
    active: 'bg-status-success/15 text-status-success',
    'on-demand': 'bg-accent/10 text-accent',
    disabled: 'bg-bg-tertiary text-text-tertiary',
    unscheduled: 'bg-status-warning/15 text-status-warning',
  }

  const stateLabel: Record<AgentState, string> = {
    active: 'active',
    'on-demand': 'on-demand',
    disabled: 'disabled',
    unscheduled: 'unscheduled',
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-xl font-semibold text-text-primary">Agents</h2>
        <div className="flex gap-0.5 border-b border-border">
          {(['all', 'active', 'on-demand', 'disabled'] as const).map((f) => {
            const count =
              f === 'all' ? agents.length :
              f === 'active' ? activeCount :
              f === 'on-demand' ? onDemandCount :
              disabledCount
            const label = f === 'on-demand' ? 'On-demand' : f[0].toUpperCase() + f.slice(1)
            return (
              <button
                key={f}
                className={`px-3 py-1.5 text-sm cursor-pointer transition-colors border-b-2 -mb-px ${filter === f ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                onClick={() => setFilter(f)}
              >
                {label} <span className="tabular-nums opacity-70">({count})</span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded" style={{ opacity: 1 - i * 0.12 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.414 2.798H4.612c-1.444 0-2.414-1.798-1.414-2.798L4.8 15.3" />
          </svg>
          <p className="text-sm text-text-secondary">
            {filter === 'all'
              ? 'No agents configured yet'
              : filter === 'active' ? 'No active scheduled agents'
              : filter === 'on-demand' ? 'No on-demand agents'
              : 'No disabled agents'}
          </p>
          {filter === 'all' && (
            <p className="text-xs text-text-tertiary">
              Open a project and add an agent from the <span className="text-text-secondary">Agents</span> tab, or bulk-create from <a href="/skills" className="text-accent hover:underline">Skills</a>.
            </p>
          )}
        </div>
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
                const state = getState(agent)
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
                        className={`px-2 py-0.5 text-xs rounded-full font-medium ${stateStyle[state]}`}
                        title={state === 'unscheduled' ? 'Scheduled but not registered in internal scheduler' : undefined}
                      >
                        {stateLabel[state]}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-medium text-text-primary" data-private>{agent.project}</td>
                    <td className="px-4 py-2 text-text-secondary font-mono text-xs" data-private>
                      {agent.name}
                      {agent.source === 'file' && (
                        <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary border border-border">file</span>
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
