'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Agent, Skill, Persona, JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { AgentsEmptyState, AgentsLoadingState } from '@/components/agents/AgentStates'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { useToast } from '@/components/Toast'
import { AgentEditor, type AgentEditorSavePayload } from '@/components/agents-tab/AgentEditor'
import { RecommendedAgents } from '@/components/agents-tab/RecommendedAgents'
import { RECOMMENDED_AGENTS } from '@/lib/agents/recommended-agents'
import { normalizeModelInput } from '@/lib/agents/model-aliases'
import { useSchedulerHealth, type SchedulerEntry } from '@/hooks/useSchedulerHealth'
import { Table, type Column } from '@/components/ui/Table'

interface AgentsTabProps {
  projectName: string
  currentBranch?: string | null
  projectJobs?: JobInfo[]
}

interface EnrichedAgent {
  agent: Agent
  skills: Skill[]
  lastRun: { ts: number; exitCode: number | null } | undefined
  schedulerEntry: SchedulerEntry | undefined
}

function scheduleToMinutes(schedule: string | null | undefined): number {
  if (!schedule) return Number.MAX_SAFE_INTEGER
  const s = schedule.trim()
  if (s.endsWith('d')) return parseInt(s) * 1440
  if (s.endsWith('h')) return parseInt(s) * 60
  if (s.endsWith('m')) return parseInt(s)
  return Number.MAX_SAFE_INTEGER
}

function formatNextFire(nextFireMs: number): string {
  const diffMs = nextFireMs - Date.now()
  if (diffMs <= 0) return 'due now'
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'in <1m'
  if (diffMin < 60) return `in ${diffMin}m`
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  return `in ${d}d ${h % 24}h`
}

function formatAgoCompact(epochMs: number): string {
  const d = Math.max(0, (Date.now() - epochMs) / 1000)
  if (d < 60) return `${Math.floor(d)}s ago`
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

export function AgentsTab({ projectName, projectJobs = [] }: AgentsTabProps) {
  const agentRunsBlocked = false
  const blockedReason = ''
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [recommendedTemplate, setRecommendedTemplate] = useState<AgentTemplateRecord | null>(null)
  const [runSubmitting, setRunSubmitting] = useState<string | null>(null)

  const { entries: schedulerEntries } = useSchedulerHealth(projectName)

  const editorParam = searchParams.get('agent')
  const templateParam = searchParams.get('template')
  const creating = editorParam === 'new'
  const editing = editorParam && editorParam !== 'new' ? agents.find(a => a.id === editorParam) ?? null : null

  const setEditorParam = (value: string | null) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()))
    if (value) next.set('agent', value)
    else {
      next.delete('agent')
      next.delete('template')
    }
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const [customTemplates, setCustomTemplates] = useState<AgentTemplateRecord[]>([])

  const loadData = async () => {
    const [agentsData, skillsData, personasData, settingsData] = await Promise.all([
      fetchAgents(projectName),
      fetchSkills(),
      fetchPersonas(),
      fetch('/api/settings').then(r => r.json()).catch(() => ({ settings: {} })),
    ])
    setAgents(agentsData.agents)
    setSkills(skillsData.skills)
    setPersonas(personasData.personas)
    try {
      const raw = settingsData.settings?.agent_templates
      if (raw) setCustomTemplates(JSON.parse(raw))
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadData() }, [projectName])

  useEffect(() => {
    if (!creating || !templateParam || recommendedTemplate) return
    const template = [...customTemplates, ...RECOMMENDED_AGENTS].find(t => t.name.toLowerCase() === templateParam.toLowerCase())
    if (template) setRecommendedTemplate(template)
  }, [creating, customTemplates, recommendedTemplate, templateParam])

  const handleDelete = async (id: string) => {
    try {
      await deleteAgent(id)
      setAgents(prev => prev.filter(a => a.id !== id))
      if (editing?.id === id) setEditorParam(null)
    } catch {}
  }

  const handleToggleEnabled = async (agent: Agent) => {
    try {
      const result = await updateAgent(agent.id, { enabled: !agent.enabled })
      setAgents(prev => prev.map(a => a.id === agent.id ? result.agent : a))
      toast(`Agent ${agent.name} ${!agent.enabled ? 'enabled' : 'disabled'}`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to toggle agent', 'error')
    }
  }

  const handleRun = async (agent: Agent) => {
    if (runSubmitting) return
    if (agentRunsBlocked) { toast(blockedReason, 'error'); return }
    const prompt = agent.prompt || `Run agent ${agent.name}`
    setRunSubmitting(agent.id)
    try {
      const result = await runAgent(agent.id, prompt)
      if (result.status === 'queued') {
        toast(result.detail || `Agent ${agent.name} queued`, 'success')
        return
      }
      toast(`Agent ${agent.name} started`, 'success')
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to run agent', 'error')
    } finally {
      setRunSubmitting(null)
    }
  }

  const closeEditor = () => { setRecommendedTemplate(null); setEditorParam(null) }

  const handleSaveAgent = async (data: AgentEditorSavePayload) => {
    const parseAgent = (a: Agent & { skillIds: string | string[]; docPaths?: string | string[] }): Agent => ({
      ...a,
      model: normalizeModelInput(a.model, 'normal'),
      skillIds: typeof a.skillIds === 'string' ? JSON.parse(a.skillIds) : a.skillIds,
      docPaths: typeof a.docPaths === 'string' ? JSON.parse(a.docPaths) : (a.docPaths ?? []),
    })
    if (editing) {
      const result = await updateAgent(editing.id, data)
      setAgents(prev => prev.map(a => a.id === editing.id ? parseAgent(result.agent) : a))
    } else {
      const result = await createAgent({ ...data, project: projectName })
      setAgents(prev => [...prev, parseAgent(result.agent)])
    }
    closeEditor()
  }

  const lastRunByAgent = new Map<string, { ts: number; exitCode: number | null }>()
  for (const job of projectJobs) {
    if (!job.kind.startsWith('agent:')) continue
    const name = job.kind.slice('agent:'.length)
    const ts = job.finished_at ?? job.started_at ?? 0
    const prev = lastRunByAgent.get(name)
    if (!prev || ts > prev.ts) lastRunByAgent.set(name, { ts, exitCode: job.exit_code })
  }

  const schedulerByAgentId = new Map(schedulerEntries.map(e => [e.agentId, e]))
  const recentAgentRuns = projectJobs.filter(job => job.kind.startsWith('agent:')).length

  const rows: EnrichedAgent[] = agents.map(agent => ({
    agent,
    skills: skills.filter(s => agent.skillIds.includes(s.id)),
    lastRun: lastRunByAgent.get(agent.name),
    schedulerEntry: schedulerByAgentId.get(agent.id),
  }))

  const columns: Column<EnrichedAgent>[] = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      sortValue: r => r.agent.name,
      cellClass: 'min-w-[160px]',
      render: r => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`font-medium text-text-primary ${!r.agent.enabled ? 'opacity-50' : ''}`}>
            {r.agent.name}
          </span>
          {r.agent.provider && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-accent/25 bg-accent/10 text-accent font-mono" title="Required provider for this agent">
              {r.agent.provider}
            </span>
          )}
          {r.agent.source === 'file' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary border border-border" title=".tamtam/agents/">
              file
            </span>
          )}
          {!r.agent.enabled && r.agent.schedule && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">off</span>
          )}
        </div>
      ),
    },
    {
      key: 'schedule',
      label: 'Schedule',
      sortable: true,
      sortValue: r => {
        if (!r.agent.enabled) return Number.MAX_SAFE_INTEGER
        const mins = scheduleToMinutes(r.agent.schedule)
        if (mins === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER - 1
        const nextMs = r.schedulerEntry?.nextFireMs
        const nextMins = nextMs != null ? Math.max(0, (nextMs - Date.now()) / 60000) : 99999
        return mins * 100000 + Math.min(nextMins, 99999)
      },
      render: r =>
        r.agent.schedule ? (
          <span className={`text-xs ${r.agent.enabled ? 'text-status-success' : 'text-text-tertiary line-through'}`}>
            every {r.agent.schedule}
          </span>
        ) : (
          <span className="text-text-tertiary text-xs">—</span>
        ),
    },
    {
      key: 'nextRun',
      label: 'Next Run',
      sortable: true,
      // Sort by actual cron run_at when available; fall back to the legacy
      // scheduler entry and finally to the schedule-relative estimate.
      sortValue: r => r.agent.cron?.nextFireMs ?? r.schedulerEntry?.nextFireMs ?? Number.MAX_SAFE_INTEGER,
      render: r => {
        if (!r.agent.schedule || !r.agent.enabled) return <span className="text-text-tertiary text-xs">—</span>
        // Prefer the live graphile queue's run_at. That's the only value
        // that reflects skipped fires being re-enqueued to a later time
        // (jobs paused, branch on fix/*, pipeline lock held, branch
        // behind origin). The legacy estimates blindly assume
        // `lastRun + interval` so they show "due now" while nothing is
        // actually queued.
        const nextMs = r.agent.cron?.nextFireMs ?? r.schedulerEntry?.nextFireMs
        const skip = r.agent.lastAttempt && r.agent.lastAttempt.status === 'skipped'
          ? r.agent.lastAttempt
          : null
        return (
          <span className="text-xs font-mono text-text-secondary" title={skip ? `Last fire skipped ${formatAgoCompact(skip.at)}: ${skip.reason}` : undefined}>
            {nextMs ? formatNextFire(nextMs) : '—'}
            {skip && (
              <span className="ml-2 text-status-warning/80">
                ({skip.reason.length > 40 ? skip.reason.slice(0, 38) + '…' : skip.reason})
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'lastRun',
      label: 'Last Run',
      sortable: true,
      sortValue: r => r.lastRun?.ts ?? 0,
      render: r => {
        if (!r.lastRun) return <span className="text-text-tertiary text-xs">never</span>
        const ago = formatAgo(r.lastRun.ts)
        const failed = r.lastRun.exitCode !== null && r.lastRun.exitCode !== 0
        return (
          <span
            className={`text-xs font-mono ${failed ? 'text-status-error/70' : 'text-text-tertiary'}`}
            title={failed ? `Failed · ${ago}` : `Ran ${ago}`}
          >
            {failed ? `✗ ${ago}` : ago}
          </span>
        )
      },
    },
    {
      key: 'model',
      label: 'Model',
      sortable: true,
      sortValue: r => r.agent.model,
      render: r => (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary whitespace-nowrap">
          {r.agent.model}
        </span>
      ),
    },
    {
      key: 'skills',
      label: 'Skills',
      cellClass: 'min-w-[120px]',
      render: r =>
        r.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {r.skills.map(s => (
              <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
                {s.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-text-tertiary text-xs">—</span>
        ),
    },
    {
      key: 'actions',
      label: '',
      headerClass: 'w-px',
      cellClass: 'text-right',
      render: r => (
        <div className="flex items-center gap-1.5 justify-end">
          {r.agent.schedule && (
            <button
              className={`px-2 py-1 text-xs border rounded-md cursor-pointer ${
                r.agent.enabled
                  ? 'border-status-success/30 text-status-success hover:bg-status-success/10'
                  : 'border-status-error/30 text-status-error hover:bg-status-error/10'
              }`}
              onClick={() => handleToggleEnabled(r.agent)}
              title={r.agent.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}
            >
              {r.agent.enabled ? 'On' : 'Off'}
            </button>
          )}
          <button
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={() => setEditorParam(r.agent.id)}
          >
            Edit
          </button>
          <button
            className="px-2.5 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => handleRun(r.agent)}
            disabled={runSubmitting === r.agent.id || agentRunsBlocked}
            title={agentRunsBlocked ? blockedReason : undefined}
          >
            {runSubmitting === r.agent.id ? 'Starting…' : 'Run'}
          </button>
        </div>
      ),
    },
  ]

  if (!loading && (creating || editing)) {
    return (
      <AgentEditor
        key={editing?.id || recommendedTemplate?.name || 'new'}
        agent={editing || undefined}
        template={(!editing && recommendedTemplate) || undefined}
        project={projectName}
        skills={skills}
        personas={personas}
        onSave={handleSaveAgent}
        onDelete={editing ? () => handleDelete(editing.id) : undefined}
        onBack={closeEditor}
      />
    )
  }

  if (loading) return (
    <div className="mt-4">
      <AgentsLoadingState rows={4} />
    </div>
  )

  const emptyState = (
    <AgentsEmptyState
      title="No agents yet"
      description="Create an agent to automate work for this project. Compose skills, pick a model, and add a schedule only when it needs to recur."
      meta="Schedules, project docs, and provider requirements can all be added later from the editor."
      stats={[
        { label: 'project', value: <span data-private>{projectName}</span> },
        { label: 'skills available', value: String(skills.length), mono: true, tone: 'accent' },
        { label: 'agent templates', value: String(customTemplates.length + RECOMMENDED_AGENTS.length), mono: true },
        { label: 'recent runs', value: String(recentAgentRuns), mono: true, tone: recentAgentRuns > 0 ? 'warning' : 'muted' },
      ]}
      primaryAction={{ label: 'New agent', onClick: () => { setRecommendedTemplate(null); setEditorParam('new') }, variant: 'primary' }}
      secondaryAction={{ label: 'Browse skills', href: '/skills' }}
      framed={false}
    />
  )

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          Agents
          {agents.length > 0 && <span className="ml-2 text-text-tertiary font-normal">{agents.length}</span>}
        </h3>
        <button
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
          onClick={() => { setRecommendedTemplate(null); setEditorParam('new') }}
        >
          + New Agent
        </button>
      </div>

      {agentRunsBlocked && (
        <div className="px-3 py-2 rounded-md border border-status-warning/40 bg-status-warning/5 text-xs text-status-warning">
          {blockedReason}
        </div>
      )}

      <Table<EnrichedAgent>
        columns={columns}
        rows={rows}
        getRowKey={r => r.agent.id}
        defaultSortKey="schedule"
        defaultSortDir="asc"
        emptyState={emptyState}
      />

      <RecommendedAgents
        agents={agents}
        customTemplates={customTemplates}
        recommendedAgents={RECOMMENDED_AGENTS}
        onAddAgent={(rec) => { setRecommendedTemplate(rec); setEditorParam('new') }}
      />
    </div>
  )
}
