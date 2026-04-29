'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas, fetchProjectDocs } from '@/lib/client-api'
import type { Agent, Skill, Persona, ProjectDoc } from '@/lib/client-api'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { useToast } from '@/components/Toast'
import { nextFireDisplay } from '@/lib/fire-times'

const MODELS = ['sonnet', 'opus', 'haiku']
const RUNNERS = ['pm2', 'launchctl']
const SCHEDULES = ['', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h']

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

const MODEL_LABELS: Record<string, { label: string; desc: string }> = {
  sonnet: { label: 'Sonnet', desc: 'Fast & capable' },
  opus: { label: 'Opus', desc: 'Most intelligent' },
  haiku: { label: 'Haiku', desc: 'Quick & light' },
}

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
    <div className="mt-4 flex flex-col gap-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="p-4 rounded-lg border border-border bg-bg-secondary flex items-center justify-between" style={{ opacity: 1 - i * 0.25 }}>
          <div className="flex flex-col gap-2">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-3 w-48" />
          </div>
          <div className="skeleton h-7 w-16 rounded-md" />
        </div>
      ))}
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
        {agents.map(agent => {
          const agentSkills = skills.filter(s => agent.skillIds.includes(s.id))
          return (
            <div
              key={agent.id}
              className={`px-3 py-2.5 rounded-lg border transition-colors ${
                editing?.id === agent.id
                  ? 'border-accent bg-accent-light'
                  : 'border-border bg-bg-secondary'
              } ${!agent.enabled ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-medium text-sm text-text-primary">{agent.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.model}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.runner}</span>
                  {agent.schedule && (
                    <>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${agent.enabled ? 'bg-status-success/10 text-status-success' : 'bg-bg-tertiary text-text-tertiary line-through'}`}>every {agent.schedule}</span>
                      {agent.enabled && nextFireDisplay(agent.schedule, agent.id) && (
                        <span className="text-[10px] text-text-tertiary font-mono">{nextFireDisplay(agent.schedule, agent.id)}</span>
                      )}
                    </>
                  )}
                  {agentSkills.map(s => (
                    <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">{s.name}</span>
                  ))}
                  {agent.source === 'file' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary border border-border" title=".tamtam/agents/">file</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {agent.schedule && agent.source !== 'file' && (
                    <button
                      className={`px-2 py-1 text-xs border rounded-md cursor-pointer ${
                        agent.enabled
                          ? 'border-status-success/30 text-status-success hover:bg-status-success/10'
                          : 'border-status-error/30 text-status-error hover:bg-status-error/10'
                      }`}
                      onClick={() => handleToggleEnabled(agent)}
                      title={agent.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}
                    >
                      {agent.enabled ? 'On' : 'Off'}
                    </button>
                  )}
                  <button
                    className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                    onClick={() => { setEditing(agent); setCreating(false) }}
                  >
                    Edit
                  </button>
                  <button
                    className="px-2 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => handleRun(agent)}
                    disabled={runSubmitting === agent.id || agentRunsBlocked}
                    title={agentRunsBlocked ? blockedReason : undefined}
                  >
                    {runSubmitting === agent.id ? 'Starting…' : 'Run'}
                  </button>
                  <button
                    className="px-2 py-1 text-xs border border-accent text-accent rounded-md hover:bg-accent/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => { setRunPromptAgent(runPromptAgent === agent.id ? null : agent.id); setRunPrompt('') }}
                    disabled={agentRunsBlocked}
                    title={agentRunsBlocked ? blockedReason : `Run ${agent.name} with a custom prompt`}
                  >
                    + prompt
                  </button>
                </div>
              </div>

              {/* Custom prompt input */}
              {runPromptAgent === agent.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    className="flex-1 px-2.5 py-1.5 text-xs bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                    value={runPrompt}
                    onChange={(e) => setRunPrompt(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && runPrompt.trim()) handleRun(agent, runPrompt.trim()) }}
                    placeholder="e.g. write tests for the streaming endpoint"
                    autoFocus
                  />
                  <button
                    className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
                    onClick={() => handleRun(agent, runPrompt.trim())}
                    disabled={!runPrompt.trim() || runSubmitting === agent.id || agentRunsBlocked}
                    title={agentRunsBlocked ? blockedReason : undefined}
                  >
                    Go
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Recommended agents */}
      {(() => {
        const existingNames = new Set(agents.map(a => a.name.toLowerCase()))
        const customNames = new Set(customTemplates.map(t => t.name.toLowerCase()))
        const merged = [
          ...customTemplates,
          ...RECOMMENDED_AGENTS.filter(r => !customNames.has(r.name.toLowerCase())),
        ]
        const suggestions = merged.filter(r => !existingNames.has(r.name.toLowerCase()))
        if (suggestions.length === 0) return null
        const essential = suggestions.filter(r => (r as RecommendedAgent).essential)
        const featured = suggestions.filter(r => (r as RecommendedAgent).featured)
        const regular = suggestions.filter(r => !(r as RecommendedAgent).essential && !(r as RecommendedAgent).featured)
        const addAgent = (rec: AgentTemplateRecord) => { setRecommendedTemplate(rec); setCreating(true); setEditing(null) }
        return (
          <div className="mt-2 flex flex-col gap-2">
            {essential.length > 0 && (
              <>
                <h3 className="text-xs font-semibold text-status-warning/80 uppercase tracking-wider">Essential</h3>
                {essential.map(rec => (
                  <div
                    key={rec.name}
                    className="p-3 rounded-lg border border-status-warning/40 bg-status-warning/5 flex items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-medium text-sm text-status-warning">{rec.name}</span>
                      {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning/80 shrink-0">every {rec.schedule}</span>}
                      {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
                    </div>
                    <button
                      className="px-3 py-1.5 text-xs border border-status-warning/50 rounded-md text-status-warning hover:bg-status-warning/10 transition-colors cursor-pointer shrink-0"
                      onClick={() => addAgent(rec)}
                    >
                      Add
                    </button>
                  </div>
                ))}
              </>
            )}
            {featured.length > 0 && (
              <>
                <h3 className="text-xs font-semibold text-accent/80 uppercase tracking-wider">Featured</h3>
                {featured.map(rec => (
                  <div
                    key={rec.name}
                    className="p-3 rounded-lg border border-accent/40 bg-accent/5 flex items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-medium text-sm text-accent">{rec.name}</span>
                      {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent/80 shrink-0">every {rec.schedule}</span>}
                      {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
                    </div>
                    <button
                      className="px-3 py-1.5 text-xs border border-accent/50 rounded-md text-accent hover:bg-accent/10 transition-colors cursor-pointer shrink-0"
                      onClick={() => addAgent(rec)}
                    >
                      Add
                    </button>
                  </div>
                ))}
              </>
            )}
            {regular.length > 0 && (
              <>
                <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mt-1">Recommended</h3>
                {regular.map(rec => {
                  const isCustom = customNames.has(rec.name.toLowerCase())
                  return (
                    <div
                      key={rec.name}
                      className="p-3 rounded-lg border border-border border-dashed bg-bg-secondary/50 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-medium text-sm text-text-secondary">{rec.name}</span>
                        {isCustom && <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">custom</span>}
                        {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary shrink-0">every {rec.schedule}</span>}
                        {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
                      </div>
                      <button
                        className="px-3 py-1.5 text-xs border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors cursor-pointer shrink-0"
                        onClick={() => addAgent(rec)}
                      >
                        Add
                      </button>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )
      })()}

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

function AgentModal({
  agent,
  template,
  project,
  skills,
  personas,
  onSave,
  onDelete,
  onClose,
}: {
  agent?: Agent
  template?: AgentTemplateRecord
  project: string
  skills: Skill[]
  personas: Persona[]
  onSave: (data: { name: string; prompt: string; skillIds: string[]; docPaths: string[]; model: string; schedule: string | null; runner: string; enabled: boolean }) => Promise<void>
  onDelete?: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(agent?.name || template?.name || '')
  const [agentPrompt, setAgentPrompt] = useState(agent?.prompt || template?.prompt || '')
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent?.skillIds || template?.skillIds || [])
  const [selectedDocPaths, setSelectedDocPaths] = useState<string[]>(agent?.docPaths || [])
  const [availableDocs, setAvailableDocs] = useState<ProjectDoc[]>([])
  const [contextTab, setContextTab] = useState<'skills' | 'docs'>('skills')
  const [model, setModel] = useState(agent?.model || template?.model || 'sonnet')
  const [schedule, setSchedule] = useState(agent?.schedule || template?.schedule || '')
  const [runner, setRunner] = useState(agent?.runner || template?.runner || 'pm2')
  const [enabled, setEnabled] = useState<boolean>(agent ? agent.enabled : true)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  const backdropRef = useRef<HTMLDivElement>(null)

  // Merge DB skills + file-based personas into unified list
  const allItems = [
    ...skills.map(s => ({ id: s.id, name: s.name, description: s.description, source: 'db' as const })),
    ...personas.map(p => ({ id: `persona:${p.path}`, name: `${p.emoji ? p.emoji + ' ' : ''}${p.name}`, description: `${p.category}${p.description ? ' — ' + p.description : ''}`, source: 'file' as const })),
  ]

  const filteredItems = skillSearch
    ? allItems.filter(item => {
        const q = skillSearch.toLowerCase()
        return item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q)
      })
    : allItems

  useEffect(() => {
    fetchProjectDocs(project).then(({ docs }) => setAvailableDocs(docs)).catch(() => {})
  }, [project])

  useEffect(() => {
    const src = agent || template
    if (!src) return
    setName(src.name || '')
    setAgentPrompt(src.prompt || '')
    setSelectedSkills(src.skillIds || [])
    setSelectedDocPaths((agent?.docPaths) || [])
    setModel(src.model || 'sonnet')
    setSchedule(src.schedule || '')
    setRunner(src.runner || 'pm2')
    if (agent) setEnabled(agent.enabled)
  }, [agent?.id, template?.name])

  useEffect(() => {
    if (!agent) nameRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const toggleSkill = (skillId: string) => {
    setSelectedSkills(prev =>
      prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]
    )
  }

  const toggleDoc = (path: string) => {
    setSelectedDocPaths(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    )
  }

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ name, prompt: agentPrompt, skillIds: selectedSkills, docPaths: selectedDocPaths, model, schedule: schedule || null, runner, enabled })
    } catch {}
    setSaving(false)
  }

  const isNew = !agent

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div
        className="bg-bg-primary rounded-2xl shadow-2xl border border-border w-full max-w-2xl flex flex-col animate-slide-in-up"
        style={{ maxHeight: '92vh' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 id="agent-modal-title" className="text-base font-semibold text-text-primary">
            {isNew ? 'New Agent' : `Edit — ${agent.name}`}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5 min-h-0">

          {/* Row 1: Name + Model */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label htmlFor="agent-name" className="block mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Name</label>
              <input
                ref={nameRef}
                id="agent-name"
                type="text"
                className="w-full px-3 py-2.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) handleSave() }}
                placeholder="e.g. security-guard"
              />
            </div>
            <div className="shrink-0">
              <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Model</div>
              <div className="flex gap-px p-0.5 rounded-lg bg-bg-secondary border border-border">
                {MODELS.map(m => {
                  const info = MODEL_LABELS[m]
                  const sel = model === m
                  return (
                    <button
                      key={m}
                      type="button"
                      title={info.desc}
                      className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-all whitespace-nowrap ${
                        sel
                          ? 'bg-accent text-white shadow-sm'
                          : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                      }`}
                      onClick={() => setModel(m)}
                    >
                      {info.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Prompt */}
          <div>
            <label htmlFor="agent-prompt" className="flex items-baseline gap-2 mb-1.5">
              <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Prompt</span>
              {selectedSkills.length > 0 && (
                <span className="text-xs text-text-tertiary font-normal normal-case">optional — skills define default behavior</span>
              )}
            </label>
            <textarea
              id="agent-prompt"
              className="w-full px-3 py-2.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors font-mono resize-none"
              rows={8}
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              placeholder={selectedSkills.length > 0
                ? 'Optional: repo-specific hints to append to the skill (e.g. "focus on lib/auth").'
                : 'What should this agent do when it runs?'}
            />
          </div>

          {/* Context: Skills + Docs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Context</span>
              <div className="flex gap-px p-0.5 rounded-md bg-bg-secondary border border-border">
                <button
                  type="button"
                  onClick={() => setContextTab('skills')}
                  className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer ${
                    contextTab === 'skills'
                      ? 'bg-bg-primary text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-primary'
                  }`}
                >
                  Skills{selectedSkills.length > 0 && <span className="ml-1.5 text-accent font-bold">{selectedSkills.length}</span>}
                </button>
                <button
                  type="button"
                  onClick={() => setContextTab('docs')}
                  className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer ${
                    contextTab === 'docs'
                      ? 'bg-bg-primary text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-primary'
                  }`}
                >
                  Docs{selectedDocPaths.length > 0 && <span className="ml-1.5 text-status-success font-bold">{selectedDocPaths.length}</span>}
                </button>
              </div>
            </div>

            {/* Selected chips */}
            {(selectedSkills.length > 0 || selectedDocPaths.length > 0) && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedSkills.map(id => {
                  const item = allItems.find(i => i.id === id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded-full bg-accent/15 text-accent border border-accent/25 font-medium">
                      {item?.name || id}
                      <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-accent/20 cursor-pointer opacity-60 hover:opacity-100 transition-opacity" onClick={() => toggleSkill(id)}>×</button>
                    </span>
                  )
                })}
                {selectedDocPaths.map(path => {
                  const doc = availableDocs.find(d => d.path === path)
                  return (
                    <span key={path} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded-full border border-status-success/30 bg-status-success/10 text-status-success font-medium">
                      {doc?.name || path}
                      <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-status-success/20 cursor-pointer opacity-60 hover:opacity-100 transition-opacity" onClick={() => toggleDoc(path)}>×</button>
                    </span>
                  )
                })}
              </div>
            )}

            {/* Skills list */}
            {contextTab === 'skills' && (
              <div className="flex flex-col gap-1.5">
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="Search skills and personas..."
                />
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                  {filteredItems.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-text-tertiary text-center">No matches</div>
                  ) : (
                    filteredItems.slice(0, 30).map(item => {
                      const isSelected = selectedSkills.includes(item.id)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`w-full px-3 py-2.5 text-left border-none cursor-pointer transition-colors flex items-center gap-3 ${
                            isSelected ? 'bg-accent/8 text-text-primary' : 'bg-transparent text-text-primary hover:bg-bg-secondary'
                          }`}
                          onClick={() => toggleSkill(item.id)}
                        >
                          <div className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                            isSelected ? 'bg-accent border-accent' : 'border-border'
                          }`}>
                            {isSelected && (
                              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1.5 4.5l2 2 4-4" />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{item.name}</span>
                              <span className={`text-[10px] px-1 py-px rounded font-medium ${item.source === 'db' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary'}`}>
                                {item.source === 'db' ? 'custom' : 'file'}
                              </span>
                            </div>
                            {item.description && (
                              <div className="text-xs text-text-tertiary truncate mt-0.5">{item.description}</div>
                            )}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {/* Docs list */}
            {contextTab === 'docs' && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {availableDocs.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-text-tertiary text-center">No docs found for this project</div>
                ) : (
                  availableDocs.map(doc => {
                    const isSelected = selectedDocPaths.includes(doc.path)
                    return (
                      <button
                        key={doc.path}
                        type="button"
                        className={`w-full px-3 py-2.5 text-left border-none cursor-pointer transition-colors flex items-center gap-3 ${
                          isSelected ? 'bg-status-success/8 text-text-primary' : 'bg-transparent text-text-primary hover:bg-bg-secondary'
                        }`}
                        onClick={() => toggleDoc(doc.path)}
                      >
                        <div className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                          isSelected ? 'bg-status-success border-status-success' : 'border-border'
                        }`}>
                          {isSelected && (
                            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1.5 4.5l2 2 4-4" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{doc.name}</div>
                          <div className="text-xs text-text-tertiary truncate">{doc.path}</div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>

          {/* Settings strip: Schedule / Runner / Enabled */}
          <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-bg-secondary border border-border">
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-text-tertiary whitespace-nowrap font-medium">Schedule</span>
              <select
                id="agent-schedule"
                className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-bg-primary border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent transition-colors cursor-pointer"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              >
                <option value="">Manual</option>
                {SCHEDULES.filter(Boolean).map(s => <option key={s} value={s}>every {s}</option>)}
              </select>
            </div>
            <div className="w-px h-4 bg-border shrink-0" />
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-text-tertiary whitespace-nowrap font-medium">Runner</span>
              <select
                id="agent-runner"
                className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-bg-primary border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent transition-colors cursor-pointer"
                value={runner}
                onChange={(e) => setRunner(e.target.value)}
              >
                {RUNNERS.map(r => <option key={r} value={r}>{r}</option>)}
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
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border shrink-0">
          <div>
            {onDelete && !confirmDelete && (
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-status-error hover:bg-status-error/10 rounded-lg transition-colors cursor-pointer"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
            {onDelete && confirmDelete && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-status-error">Delete this agent?</span>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm text-white bg-status-error rounded-lg hover:bg-status-error/90 cursor-pointer"
                  onClick={() => { onDelete(); onClose() }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary cursor-pointer"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSave}
              disabled={!name.trim() || saving}
            >
              {saving ? 'Saving…' : isNew ? 'Create Agent' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
