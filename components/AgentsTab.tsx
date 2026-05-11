'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Agent, Skill, Persona, JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { useToast } from '@/components/Toast'
import { AgentEditor, type AgentEditorSavePayload } from '@/components/agents-tab/AgentEditor'
import { RecommendedAgents } from '@/components/agents-tab/RecommendedAgents'
import { RECOMMENDED_AGENTS } from '@/lib/agents/recommended-agents'
import { normalizeModelInput } from '@/lib/agents/model-aliases'
import { nextFireDisplay } from '@/lib/scheduling/fire-times'
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
      sortValue: r => r.schedulerEntry?.nextFireMs ?? Number.MAX_SAFE_INTEGER,
      render: r => {
        if (!r.agent.schedule || !r.agent.enabled) return <span className="text-text-tertiary text-xs">—</span>
        const display = nextFireDisplay(r.agent.schedule, r.agent.id)
        return display ? (
          <span className="text-xs text-text-secondary font-mono">{display}</span>
        ) : (
          <span className="text-text-tertiary text-xs">—</span>
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
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-8 w-28 rounded-md" />
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="bg-bg-secondary border-b border-border px-3 py-2 flex gap-8">
          {['w-12', 'w-16', 'w-14', 'w-16', 'w-10', 'w-12'].map((w, i) => (
            <div key={i} className={`skeleton h-3 ${w} rounded`} />
          ))}
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-3 py-3 border-b border-border last:border-0 flex items-center gap-8">
            <div className="skeleton h-4 w-28 rounded" />
            <div className="skeleton h-4 w-16 rounded-full" />
            <div className="skeleton h-4 w-20 rounded" />
            <div className="skeleton h-4 w-16 rounded" />
            <div className="skeleton h-4 w-24 rounded-full" />
            <div className="skeleton h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  )

  const emptyState = (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.177.073a2.25 2.25 0 012.148 0l.177-.073a2.25 2.25 0 001.357-2.059V3.104m-7.5 0A24.26 24.26 0 0112 3c.83 0 1.643.038 2.438.104" />
      </svg>
      <p className="text-sm text-text-secondary font-medium">No agents yet</p>
      <p className="text-xs text-text-tertiary max-w-xs">Create an agent to automate tasks for this project — compose skills, pick a model, and set a schedule.</p>
    </div>
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
