'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Agent, Skill, Persona } from '@/lib/client-api'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { useToast } from '@/components/Toast'
import { AgentModal } from '@/components/agents-tab/AgentModal'
import { AgentRow } from '@/components/agents-tab/AgentRow'
import { RecommendedAgents } from '@/components/agents-tab/RecommendedAgents'

interface RecommendedAgent extends AgentTemplateRecord {
  skillIds: string[]
  essential?: boolean
  featured?: boolean
}

const RECOMMENDED_AGENTS: RecommendedAgent[] = [
  {
    name: 'security-review',
    description: 'Scans uncommitted diffs for OWASP issues, secrets, and vulnerabilities.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-security-review'],
  },
  {
    name: 'dependency-check',
    description: 'Scans for outdated or vulnerable dependencies and suggests updates.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-dependency-check'],
  },
  {
    name: 'ci-monitor',
    description: 'Checks GitHub Actions status and applies fixes when the latest run fails.',
    model: 'sonnet',
    schedule: '30m',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-ci-monitor'],
  },
  {
    name: 'release-ready',
    description: 'Pre-flight check: runs tests and surfaces whether the project is ready to ship.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-release-ready'],
  },
  {
    name: 'tests',
    description: 'Adds missing tests for recently changed code and fills gaps in coverage.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-tests'],
  },
  {
    name: 'cto',
    description: 'Thinks from a CTO perspective about product direction and creates prioritized GitHub issues for missing features, gaps, and strategic improvements.',
    model: 'opus',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-cto'],
  },
  {
    name: 'gha-audit',
    description: 'Audits GitHub Actions workflows and creates missing ones for CI, release, and labels.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-gha-audit'],
  },
  {
    name: 'readme-sync',
    description: 'Verifies README.md is accurate and updates it to reflect the current state of the project.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-readme-sync'],
  },
  {
    name: 'docs-claude',
    description: 'Audits CLAUDE.md for completeness — adds missing guidance on security, coding conventions, testing rules, and best patterns so Claude behaves correctly on every run.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-docs-claude'],
    essential: true,
  },
  {
    name: 'manage-agents',
    description: 'Audits TamTam agents for this project and creates, updates, or removes them to match current project needs.',
    model: 'sonnet',
    schedule: '24h',
    runner: 'pm2',
    prompt: '',
    skillIds: ['agent-manage-agents'],
    featured: true,
  },
]

interface AgentsTabProps {
  projectName: string
  currentBranch?: string | null
  prWorkflowEnabled?: boolean
}

export function AgentsTab({ projectName, currentBranch, prWorkflowEnabled }: AgentsTabProps) {
  // Server rejects agent runs in Direct Branch mode while a fix/issue-* branch
  // is checked out (see app/api/agents/[agentId]/run/route.ts). Mirror that
  // check on the client so the buttons reflect reality.
  const agentRunsBlocked = !prWorkflowEnabled && !!currentBranch?.startsWith('fix/issue-')
  const blockedReason = agentRunsBlocked
    ? `Direct Branch mode is on while issue branch '${currentBranch}' is checked out — finish or abandon the issue work first.`
    : ''
  const router = useRouter()
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [creating, setCreating] = useState(false)
  const [recommendedTemplate, setRecommendedTemplate] = useState<AgentTemplateRecord | null>(null)
  const [runSubmitting, setRunSubmitting] = useState<string | null>(null)
  const [runPromptAgent, setRunPromptAgent] = useState<string | null>(null)
  const [runPrompt, setRunPrompt] = useState('')

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

  const handleDelete = async (id: string) => {
    try {
      await deleteAgent(id)
      setAgents(prev => prev.filter(a => a.id !== id))
      if (editing?.id === id) setEditing(null)
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

  const handleRun = async (agent: Agent, customPrompt?: string) => {
    if (runSubmitting) return
    if (agentRunsBlocked) {
      toast(blockedReason, 'error')
      return
    }
    const prompt = customPrompt || agent.prompt || `Run agent ${agent.name}`
    setRunSubmitting(agent.id)
    try {
      const result = await runAgent(agent.id, prompt)
      toast(`Agent ${agent.name} started`, 'success')
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to run agent', 'error')
    } finally {
      setRunSubmitting(null)
      setRunPromptAgent(null)
      setRunPrompt('')
    }
  }

  const closeModal = () => { setEditing(null); setCreating(false); setRecommendedTemplate(null) }

  const handleSaveAgent = async (data: { name: string; prompt: string; skillIds: string[]; docPaths: string[]; model: string; schedule: string | null; runner: string; enabled: boolean }) => {
    const parseAgent = (a: Agent & { skillIds: string | string[]; docPaths?: string | string[] }): Agent => ({
      ...a,
      skillIds: typeof a.skillIds === 'string' ? JSON.parse(a.skillIds) : a.skillIds,
      docPaths: typeof a.docPaths === 'string' ? JSON.parse(a.docPaths) : (a.docPaths ?? []),
    })
    if (editing) {
      const result = await updateAgent(editing.id, data)
      const updated = parseAgent(result.agent)
      setAgents(prev => prev.map(a => a.id === editing.id ? updated : a))
    } else {
      const result = await createAgent({ ...data, project: projectName })
      const created = parseAgent(result.agent)
      setAgents(prev => [...prev, created])
    }
    closeModal()
  }

  if (loading) return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-8 w-28 rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => {
          const chipWidths = [['w-14', 'w-12', 'w-20'], ['w-16', 'w-14', 'w-24', 'w-16'], ['w-14', 'w-16', 'w-20'], ['w-16', 'w-12']][i]
          return (
            <div key={i} className="px-3 py-2.5 rounded-lg border border-border bg-bg-secondary flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
                <div className="skeleton h-4 w-32 rounded" />
                {chipWidths.map((w, j) => (
                  <div key={j} className={`skeleton h-4 ${w} rounded-full`} />
                ))}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="skeleton h-7 w-7 rounded-md" />
                <div className="skeleton h-7 w-12 rounded-md" />
                <div className="skeleton h-7 w-7 rounded-md" />
              </div>
            </div>
          )
        })}
      </div>
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
          onClick={() => { setRecommendedTemplate(null); setCreating(true); setEditing(null); setRunPromptAgent(null) }}
        >
          + New Agent
        </button>
      </div>

      {agentRunsBlocked && (
        <div className="px-3 py-2 rounded-md border border-status-warning/40 bg-status-warning/5 text-xs text-status-warning">
          {blockedReason}
        </div>
      )}

      {/* Agent list */}
      {agents.length === 0 && !creating && (
        <div className="flex flex-col items-center gap-2 py-10 text-center bg-bg-secondary rounded-lg border border-border">
          <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.177.073a2.25 2.25 0 012.148 0l.177-.073a2.25 2.25 0 001.357-2.059V3.104m-7.5 0A24.26 24.26 0 0112 3c.83 0 1.643.038 2.438.104" />
          </svg>
          <p className="text-sm text-text-secondary font-medium">No agents yet</p>
          <p className="text-xs text-text-tertiary max-w-xs">Create an agent to automate tasks for this project — compose skills, pick a model, and set a schedule.</p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {agents.map(agent => (
          <AgentRow
            key={agent.id}
            agent={agent}
            skills={skills}
            editing={editing}
            runSubmitting={runSubmitting}
            runPromptAgent={runPromptAgent}
            runPrompt={runPrompt}
            agentRunsBlocked={agentRunsBlocked}
            blockedReason={blockedReason}
            onEdit={(a) => { setEditing(a); setCreating(false) }}
            onToggleEnabled={handleToggleEnabled}
            onRun={handleRun}
            onToggleRunPrompt={(id) => { setRunPromptAgent(runPromptAgent === id ? null : id); setRunPrompt('') }}
            onRunPromptChange={setRunPrompt}
          />
        ))}
      </div>

      {/* Recommended agents */}
      <RecommendedAgents
        agents={agents}
        customTemplates={customTemplates}
        recommendedAgents={RECOMMENDED_AGENTS}
        onAddAgent={(rec) => { setRecommendedTemplate(rec); setCreating(true); setEditing(null) }}
      />

      {/* Agent modal */}
      {(creating || editing) && (
        <AgentModal
          key={editing?.id || recommendedTemplate?.name || 'new'}
          agent={editing || undefined}
          template={(!editing && recommendedTemplate) || undefined}
          project={projectName}
          skills={skills}
          personas={personas}
          onSave={handleSaveAgent}
          onDelete={editing ? () => handleDelete(editing.id) : undefined}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
