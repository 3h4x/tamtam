'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas, fetchSettings } from '@/lib/client-api'
import type { Agent, Skill, Persona, JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { AgentsEmptyState, AgentsLoadingState } from '@/components/agents/AgentStates'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { useToast } from '@/components/Toast'
import { AgentEditor, type AgentEditorSavePayload } from '@/components/agents-tab/AgentEditor'
import { RecommendedAgents } from '@/components/agents-tab/RecommendedAgents'
import { RECOMMENDED_AGENTS, recommendedAgentMatchesName } from '@/lib/agents/recommended-agents'
import { normalizeModelInput } from '@/lib/agents/model-aliases'
import { useSchedulerHealth, type SchedulerEntry } from '@/hooks/useSchedulerHealth'
import { useAgentStats } from '@/hooks/useAgentStats'
import { formatCost } from '@/components/project-runs/formatting'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Pill } from '@/components/ui/Pill'
import { Table, type Column } from '@/components/ui/Table'
import { Textarea } from '@/components/ui/Textarea'

interface AgentsTabProps {
  projectName: string
  currentBranch?: string | null
  projectJobs?: JobInfo[]
  jobsPaused?: boolean
}

interface EnrichedAgent {
  agent: Agent
  skills: Skill[]
  lastRun: { ts: number; exitCode: number | null; status: string } | undefined
  schedulerEntry: SchedulerEntry | undefined
}

const EMPTY_SEARCH_PARAMS = new URLSearchParams()

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

export function AgentsTab({ projectName, projectJobs = [], jobsPaused = false }: AgentsTabProps) {
  // Mirror the server-side global pause gate (POST /api/agents/[agentId]/run
  // returns 409 jobs_paused) so the Run buttons reflect reality instead of
  // letting the user fire a request that the server will reject.
  const agentRunsBlocked = jobsPaused
  const blockedReason = jobsPaused
    ? 'Jobs are paused globally. Resume jobs in Settings to run agents.'
    : ''
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams() ?? EMPTY_SEARCH_PARAMS
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [recommendedTemplate, setRecommendedTemplate] = useState<AgentTemplateRecord | null>(null)
  const [runSubmitting, setRunSubmitting] = useState<string | null>(null)
  const [customRunOpenId, setCustomRunOpenId] = useState<string | null>(null)
  const [customRunInput, setCustomRunInput] = useState<Record<string, string>>({})

  const { entries: schedulerEntries } = useSchedulerHealth(projectName)
  const { byName: agentStats } = useAgentStats(projectName)

  const editorParam = searchParams.get('agent')
  const templateParam = searchParams.get('template')
  const creating = editorParam === 'new'
  const editing = editorParam && editorParam !== 'new' ? agents.find(a => a.id === editorParam) ?? null : null

  const setEditorParam = (value: string | null) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()))
    next.delete('improve')
    if (value) next.set('agent', value)
    else {
      next.delete('agent')
      next.delete('template')
    }
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  // Strip the one-shot `improve` flag from the URL after the editor consumes it
  // so a re-render or back-navigation doesn't re-trigger an improve run.
  const clearImproveParam = () => {
    if (!searchParams.get('improve')) return
    const next = new URLSearchParams(Array.from(searchParams.entries()))
    next.delete('improve')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }

  const [customTemplates, setCustomTemplates] = useState<AgentTemplateRecord[]>([])

  const loadData = async () => {
    const [agentsData, skillsData, personasData, settingsData] = await Promise.all([
      fetchAgents(projectName),
      fetchSkills(),
      fetchPersonas(),
      fetchSettings().catch(() => ({ settings: {} as Record<string, string | undefined> })),
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
    const template = [
      ...customTemplates.filter(t => t.name.trim().toLowerCase() === templateParam.trim().toLowerCase()),
      ...RECOMMENDED_AGENTS.filter(t => recommendedAgentMatchesName(t, templateParam)),
    ][0]
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

  const handleRun = async (agent: Agent, extraContext?: string) => {
    if (runSubmitting) return
    if (agentRunsBlocked) { toast(blockedReason, 'error'); return }
    const basePrompt = agent.prompt || `Run agent ${agent.name}`
    const trimmedExtra = extraContext?.trim() ?? ''
    const prompt = trimmedExtra
      ? (agent.prompt ? `${agent.prompt}\n\n---\n\n${trimmedExtra}` : trimmedExtra)
      : basePrompt
    setRunSubmitting(agent.id)
    try {
      const result = await runAgent(agent.id, prompt)
      if (result.status === 'queued') {
        toast(result.detail || `Agent ${agent.name} queued`, 'success')
        return
      }
      toast(`Agent ${agent.name} started`, 'success')
      setCustomRunOpenId(null)
      setCustomRunInput(prev => {
        const next = { ...prev }
        delete next[agent.id]
        return next
      })
      router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to run agent', 'error')
    } finally {
      setRunSubmitting(null)
    }
  }

  const toggleCustomRun = (agentId: string) => {
    setCustomRunOpenId(prev => (prev === agentId ? null : agentId))
  }

  const closeEditor = () => {
    setRecommendedTemplate(null)
    clearImproveParam()
    setEditorParam(null)
  }

  const parseAgent = (a: Agent & { skillIds: string | string[]; docPaths?: string | string[] }): Agent => ({
    ...a,
    model: normalizeModelInput(a.model, 'normal'),
    skillIds: typeof a.skillIds === 'string' ? JSON.parse(a.skillIds) : a.skillIds,
    docPaths: typeof a.docPaths === 'string' ? JSON.parse(a.docPaths) : (a.docPaths ?? []),
  })

  const handleSaveAgent = async (data: AgentEditorSavePayload) => {
    if (editing) {
      const result = await updateAgent(editing.id, data)
      setAgents(prev => prev.map(a => a.id === editing.id ? parseAgent(result.agent) : a))
    } else {
      const result = await createAgent({ ...data, project: projectName })
      setAgents(prev => [...prev, parseAgent(result.agent)])
    }
    closeEditor()
  }

  const lastRunByAgent = new Map<string, { ts: number; exitCode: number | null; status: string }>()
  for (const job of projectJobs) {
    if (!job.kind.startsWith('agent:')) continue
    const name = job.kind.slice('agent:'.length)
    const ts = job.finished_at ?? job.started_at ?? 0
    const prev = lastRunByAgent.get(name)
    if (!prev || ts > prev.ts) lastRunByAgent.set(name, { ts, exitCode: job.exit_code, status: job.status })
  }

  const schedulerByAgentId = new Map(schedulerEntries.map(e => [e.agentId, e]))
  const recentAgentRuns = projectJobs.filter(job => job.kind.startsWith('agent:')).length

  // Build skill lookup once instead of doing `skills.filter(includes)` per
  // agent (O(N×M×K) → O(N + Σ K) where N is the skills array, M is agents,
  // K is the per-agent skillIds length).
  const skillsById = new Map(skills.map(s => [s.id, s]))
  const rows: EnrichedAgent[] = agents.map(agent => ({
    agent,
    skills: agent.skillIds.map(id => skillsById.get(id)).filter((s): s is Skill => s !== undefined),
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
            <Pill tone="accent" size="xs" className="rounded-full border-accent/25 px-1.5 py-0.5 font-mono text-[10px]" title="Required provider for this agent">
              {r.agent.provider}
            </Pill>
          )}
          {r.agent.kind === 'system' && (
            <Pill
              tone="accent"
              size="xs"
              className="rounded-full border-accent/30 px-1.5 py-0.5 text-[10px]"
              title="Built-in system agent — auto-managed by TamTam"
            >system</Pill>
          )}
          {!r.agent.enabled && r.agent.schedule && (
            <Pill tone="neutral" size="xs" className="rounded-full border-transparent bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-tertiary">off</Pill>
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
        const running = r.lastRun.status === 'running'
        const cancelled = isCancelledExitCode(r.lastRun.exitCode)
        const failed = !cancelled && r.lastRun.exitCode !== null && r.lastRun.exitCode !== 0
        const title = running ? `Running · started ${ago}` : cancelled ? `Cancelled · ${ago}` : failed ? `Failed · ${ago}` : `Ran ${ago}`
        return (
          <span
            className={`text-xs font-mono ${
              running
                ? 'text-status-info/80'
                : failed || cancelled
                  ? 'text-status-error/70'
                  : 'text-text-tertiary'
            }`}
            title={title}
          >
            {running ? 'running' : failed || cancelled ? `✗ ${ago}` : ago}
          </span>
        )
      },
    },
    {
      key: 'health',
      label: 'Health',
      title: 'Run success rate, files touched and cost over the stats window — is this agent productive?',
      sortable: true,
      sortValue: r => {
        const s = agentStats.get(r.agent.name)
        if (!s || s.finishedRuns === 0) return -1
        return Math.round((s.successfulRuns / s.finishedRuns) * 100)
      },
      render: r => {
        const s = agentStats.get(r.agent.name)
        if (!s || s.finishedRuns === 0) return <span className="text-text-tertiary text-xs">—</span>
        const rate = Math.round((s.successfulRuns / s.finishedRuns) * 100)
        const tone = rate >= 70 ? 'success' : rate >= 40 ? 'warning' : 'error'
        return (
          <div className="flex flex-col gap-0.5">
            <Pill
              tone={tone}
              size="xs"
              className="w-fit rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
              title={`${s.successfulRuns}/${s.finishedRuns} runs succeeded${s.reviewFixesTriggered > 0 ? ` · ${s.reviewFixesTriggered} fixes triggered` : ''}`}
            >
              {rate}%
            </Pill>
            {(s.modifiedFilesCount > 0 || s.costUsd > 0) && (
              <span className="text-[10px] text-text-tertiary tabular-nums">
                {s.modifiedFilesCount > 0 ? `${s.modifiedFilesCount}f` : ''}
                {s.modifiedFilesCount > 0 && s.costUsd > 0 ? ' · ' : ''}
                {s.costUsd > 0 ? formatCost(s.costUsd) : ''}
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'model',
      label: 'Model',
      sortable: true,
      sortValue: r => r.agent.model,
      render: r => (
        <Pill tone="neutral" size="xs" className="rounded-full border-transparent bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary whitespace-nowrap">
          {r.agent.model}
        </Pill>
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
              <Pill key={s.id} tone="accent" size="xs" className="rounded-full border-transparent px-1.5 py-0.5 text-[10px]">
                {s.name}
              </Pill>
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
            <Button
              size="sm"
              variant={r.agent.enabled ? 'success' : 'danger'}
              onClick={() => handleToggleEnabled(r.agent)}
              title={r.agent.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}
            >
              {r.agent.enabled ? 'On' : 'Off'}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => setEditorParam(r.agent.id)}
          >
            Edit
          </Button>
          <div className="inline-flex rounded-md overflow-hidden">
            <Button
              variant="solid"
              size="sm"
              className="rounded-r-none px-2.5"
              onClick={() => handleRun(r.agent)}
              disabled={runSubmitting === r.agent.id || agentRunsBlocked}
              title={agentRunsBlocked ? blockedReason : r.agent.kind === 'system' ? 'Run the built-in system handler now' : undefined}
            >
              {runSubmitting === r.agent.id ? 'Starting…' : 'Run'}
            </Button>
            {r.agent.kind !== 'system' && (
              <Button
                variant="solid"
                size="sm"
                className="rounded-l-none px-1.5 border-l border-white/20"
                onClick={() => toggleCustomRun(r.agent.id)}
                disabled={runSubmitting === r.agent.id || agentRunsBlocked}
                aria-label="Run with additional context"
                aria-expanded={customRunOpenId === r.agent.id}
                title="Run with additional context"
              >
                <span className={`inline-block transition-transform ${customRunOpenId === r.agent.id ? 'rotate-180' : ''}`}>▾</span>
              </Button>
            )}
          </div>
        </div>
      ),
    },
  ]

  const renderExpanded = (r: EnrichedAgent) => {
    if (r.agent.kind === 'system') return null
    if (customRunOpenId !== r.agent.id) return null
    const value = customRunInput[r.agent.id] ?? ''
    const submitting = runSubmitting === r.agent.id
    return (
      <div className="flex flex-col gap-2">
        <label className="text-xs text-text-secondary">
          Additional context for <span className="font-medium text-text-primary">{r.agent.name}</span>
          <span className="ml-1 text-text-tertiary">(appended to the agent's prompt)</span>
        </label>
        <Textarea
          className="min-h-[80px]"
          resize="both"
          placeholder="e.g. focus on the auth module, ignore generated files…"
          value={value}
          onChange={e => setCustomRunInput(prev => ({ ...prev, [r.agent.id]: e.target.value }))}
          disabled={submitting}
          autoFocus
        />
        <div className="flex items-center gap-2 justify-end">
          <Button
            size="sm"
            className="text-text-secondary"
            onClick={() => setCustomRunOpenId(null)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="solid"
            size="sm"
            className="px-2.5"
            onClick={() => handleRun(r.agent, value)}
            disabled={submitting || agentRunsBlocked}
            title={agentRunsBlocked ? blockedReason : undefined}
          >
            {submitting ? 'Starting…' : value.trim() ? 'Run with context' : 'Run'}
          </Button>
        </div>
      </div>
    )
  }

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
        onReverted={(agent) => {
          const parsed = parseAgent(agent)
          setAgents(prev => prev.map(a => a.id === parsed.id ? parsed : a))
        }}
        autoImprove={Boolean(editing) && searchParams.get('improve') === '1'}
        onAutoImproveConsumed={clearImproveParam}
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
        <Button
          variant="solid"
          onClick={() => { setRecommendedTemplate(null); setEditorParam('new') }}
        >
          + New Agent
        </Button>
      </div>

      {agentRunsBlocked && (
        <ErrorCallout tone="warning" padding="none" radius="md" className="px-3 py-2 text-xs" preWrap={false}>
          {blockedReason}
        </ErrorCallout>
      )}

      <Table<EnrichedAgent>
        columns={columns}
        rows={rows}
        getRowKey={r => r.agent.id}
        defaultSortKey="schedule"
        defaultSortDir="asc"
        emptyState={emptyState}
        expandedRender={renderExpanded}
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
