'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Agent, Skill, Persona } from '@/lib/client-api'
import { useToast } from '@/components/Toast'

const MODELS = ['sonnet', 'opus', 'haiku']
const RUNNERS = ['pm2', 'launchctl']
const SCHEDULES = ['', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h']

const MODEL_LABELS: Record<string, { label: string; desc: string }> = {
  sonnet: { label: 'Sonnet', desc: 'Fast & capable' },
  opus: { label: 'Opus', desc: 'Most intelligent' },
  haiku: { label: 'Haiku', desc: 'Quick & light' },
}

interface AgentsTabProps {
  projectName: string
}

export function AgentsTab({ projectName }: AgentsTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [creating, setCreating] = useState(false)
  const [runSubmitting, setRunSubmitting] = useState<string | null>(null)
  const [runPromptAgent, setRunPromptAgent] = useState<string | null>(null)
  const [runPrompt, setRunPrompt] = useState('')

  const loadData = async () => {
    const [agentsData, skillsData, personasData] = await Promise.all([
      fetchAgents(projectName),
      fetchSkills(),
      fetchPersonas(),
    ])
    setAgents(agentsData.agents)
    setSkills(skillsData.skills)
    setPersonas(personasData.personas)
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
      const result = await updateAgent(agent.id, { enabled: !agent.enabled } as any)
      const updated = { ...result.agent, skillIds: typeof result.agent.skillIds === 'string' ? JSON.parse(result.agent.skillIds as any) : result.agent.skillIds }
      setAgents(prev => prev.map(a => a.id === agent.id ? updated : a))
      toast(`Agent ${agent.name} ${!agent.enabled ? 'enabled' : 'disabled'}`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to toggle agent', 'error')
    }
  }

  const handleRun = async (agent: Agent, customPrompt?: string) => {
    if (runSubmitting) return
    const prompt = customPrompt || agent.prompt || `Run agent ${agent.name}`
    setRunSubmitting(agent.id)
    try {
      const result = await runAgent(agent.id, prompt)
      toast(`Agent ${agent.name} started`, 'success')
      router.push(`/project/${projectName}/jobs/${result.job_id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to run agent', 'error')
    } finally {
      setRunSubmitting(null)
      setRunPromptAgent(null)
      setRunPrompt('')
    }
  }

  const closeModal = () => { setEditing(null); setCreating(false) }

  const handleSaveAgent = async (data: { name: string; prompt: string; skillIds: string[]; model: string; schedule: string | null; runner: string }) => {
    const parseAgent = (a: any): Agent => ({
      ...a,
      skillIds: typeof a.skillIds === 'string' ? JSON.parse(a.skillIds) : a.skillIds,
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

  if (loading) return <div className="mt-4 text-text-secondary text-sm">Loading...</div>

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          Agents
          {agents.length > 0 && <span className="ml-2 text-text-tertiary font-normal">{agents.length}</span>}
        </h3>
        <button
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
          onClick={() => { setCreating(true); setEditing(null); setRunPromptAgent(null) }}
        >
          + New Agent
        </button>
      </div>

      {/* Agent list */}
      {agents.length === 0 && !creating && (
        <div className="text-text-secondary text-sm p-4 bg-bg-secondary rounded-lg">
          No agents defined for this project. Create one to get started.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {agents.map(agent => {
          const agentSkills = skills.filter(s => agent.skillIds.includes(s.id))
          return (
            <div
              key={agent.id}
              className={`p-4 rounded-lg border transition-colors ${
                editing?.id === agent.id
                  ? 'border-accent bg-accent-light'
                  : 'border-border bg-bg-secondary'
              } ${!agent.enabled ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-text-primary">{agent.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.model}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">{agent.runner}</span>
                  {agent.schedule && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${agent.enabled ? 'bg-status-success/10 text-status-success' : 'bg-bg-tertiary text-text-tertiary line-through'}`}>every {agent.schedule}</span>
                  )}
                  {agentSkills.map(s => (
                    <span key={s.id} className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">{s.name}</span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {agent.schedule && (
                    <button
                      className={`px-3 py-1.5 text-sm border rounded-md cursor-pointer ${
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
                    className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                    onClick={() => { setEditing(agent); setCreating(false) }}
                  >
                    Edit
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
                    onClick={() => handleRun(agent)}
                    disabled={runSubmitting === agent.id}
                  >
                    {runSubmitting === agent.id ? 'Starting...' : 'Run'}
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm border border-accent text-accent rounded-md hover:bg-accent/10 cursor-pointer"
                    onClick={() => { setRunPromptAgent(runPromptAgent === agent.id ? null : agent.id); setRunPrompt('') }}
                  >
                    Run with prompt
                  </button>
                </div>
              </div>

              {/* Custom prompt input */}
              {runPromptAgent === agent.id && (
                <div className="mt-3 flex gap-2">
                  <input
                    type="text"
                    className="flex-1 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                    value={runPrompt}
                    onChange={(e) => setRunPrompt(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && runPrompt.trim()) handleRun(agent, runPrompt.trim()) }}
                    placeholder="e.g. write tests for the streaming endpoint"
                    autoFocus
                  />
                  <button
                    className="px-4 py-2 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
                    onClick={() => handleRun(agent, runPrompt.trim())}
                    disabled={!runPrompt.trim() || runSubmitting === agent.id}
                  >
                    Go
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Agent modal */}
      {(creating || editing) && (
        <AgentModal
          agent={editing || undefined}
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
  skills,
  personas,
  onSave,
  onDelete,
  onClose,
}: {
  agent?: Agent
  skills: Skill[]
  personas: Persona[]
  onSave: (data: { name: string; prompt: string; skillIds: string[]; model: string; schedule: string | null; runner: string }) => Promise<void>
  onDelete?: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(agent?.name || '')
  const [agentPrompt, setAgentPrompt] = useState(agent?.prompt || '')
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent?.skillIds || [])
  const [model, setModel] = useState(agent?.model || 'sonnet')
  const [schedule, setSchedule] = useState(agent?.schedule || '')
  const [runner, setRunner] = useState(agent?.runner || 'pm2')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [modalTab, setModalTab] = useState<'all' | 'prompt'>('all')
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
    setName(agent?.name || '')
    setAgentPrompt(agent?.prompt || '')
    setSelectedSkills(agent?.skillIds || [])
    setModel(agent?.model || 'sonnet')
    setSchedule(agent?.schedule || '')
    setRunner(agent?.runner || 'pm2')
  }, [agent?.id])

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

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ name, prompt: agentPrompt, skillIds: selectedSkills, model, schedule: schedule || null, runner })
    } catch {}
    setSaving(false)
  }

  const isNew = !agent

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div
        className="bg-bg-primary rounded-xl shadow-2xl border border-border w-full max-w-4xl mx-4 animate-slide-in-up overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 id="agent-modal-title" className="text-lg font-semibold text-text-primary">
              {isNew ? 'New Agent' : 'Edit Agent'}
            </h2>
            <p className="text-sm text-text-tertiary mt-0.5">
              {isNew ? 'Configure an automated Claude agent' : `Editing ${agent.name}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body — two columns */}
        <div className="flex">
          {/* Left column: config */}
          <div className="flex-1 px-6 py-5 flex flex-col gap-5 border-r border-border overflow-y-auto" style={{ maxHeight: '70vh' }}>
          {/* Name field */}
          <div>
            <label htmlFor="agent-name" className="block mb-1.5 text-sm font-medium text-text-primary">Name</label>
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

          {/* Model selection as cards */}
          <div>
            <label className="block mb-2 text-sm font-medium text-text-primary">Model</label>
            <div className="grid grid-cols-3 gap-2">
              {MODELS.map(m => {
                const info = MODEL_LABELS[m]
                const selected = model === m
                return (
                  <button
                    key={m}
                    type="button"
                    className={`flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-sm cursor-pointer transition-all ${
                      selected
                        ? 'border-accent bg-accent/10 text-accent ring-1 ring-accent/30'
                        : 'border-border bg-bg-secondary text-text-primary hover:border-accent/50'
                    }`}
                    onClick={() => setModel(m)}
                  >
                    <span className="font-medium">{info.label}</span>
                    <span className={`text-xs ${selected ? 'text-accent/70' : 'text-text-tertiary'}`}>{info.desc}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Schedule & Runner row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="agent-schedule" className="block mb-1.5 text-sm font-medium text-text-primary">Schedule</label>
              <select
                id="agent-schedule"
                className="w-full px-3 py-2.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors cursor-pointer"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              >
                <option value="">Manual</option>
                {SCHEDULES.filter(Boolean).map(s => <option key={s} value={s}>every {s}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="agent-runner" className="block mb-1.5 text-sm font-medium text-text-primary">Runner</label>
              <select
                id="agent-runner"
                className="w-full px-3 py-2.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors cursor-pointer"
                value={runner}
                onChange={(e) => setRunner(e.target.value)}
              >
                {RUNNERS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          {/* Skills */}
          <div>
            <label className="block mb-2 text-sm font-medium text-text-primary">
              Skills
              {selectedSkills.length > 0 && (
                <span className="ml-2 text-xs font-normal text-accent">{selectedSkills.length} selected</span>
              )}
            </label>

            {/* Selected skills */}
            {selectedSkills.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {selectedSkills.map(id => {
                  const item = allItems.find(i => i.id === id)
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-accent text-white"
                    >
                      {item?.name || id}
                      <button
                        type="button"
                        className="text-white/70 hover:text-white ml-0.5 cursor-pointer"
                        onClick={() => toggleSkill(id)}
                      >
                        x
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {/* Search input */}
            <input
              type="text"
              className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors mb-2"
              value={skillSearch}
              onChange={(e) => setSkillSearch(e.target.value)}
              placeholder="Search skills and personas..."
            />

            {/* Results */}
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border">
              {filteredItems.length === 0 ? (
                <div className="px-3 py-2 text-xs text-text-tertiary">No matches</div>
              ) : (
                filteredItems.slice(0, 30).map(item => {
                  const isSelected = selectedSkills.includes(item.id)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`w-full px-3 py-2 text-left text-sm border-none cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-accent/10 text-accent'
                          : 'bg-transparent text-text-primary hover:bg-bg-secondary'
                      }`}
                      onClick={() => toggleSkill(item.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${item.source === 'db' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary'}`}>
                          {item.source === 'db' ? 'custom' : 'file'}
                        </span>
                      </div>
                      {item.description && (
                        <div className="text-xs text-text-tertiary truncate mt-0.5">{item.description}</div>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
          </div>

          {/* Right column: prompt */}
          <div className="flex-1 px-6 py-5 flex flex-col" style={{ maxHeight: '70vh' }}>
            <label htmlFor="agent-prompt" className="block mb-1.5 text-sm font-medium text-text-primary">Prompt</label>
            <textarea
              id="agent-prompt"
              className="flex-1 w-full px-3 py-2.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors font-mono resize-none"
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              placeholder="What should this agent do when it runs?"
            />
            <p className="text-xs text-text-tertiary mt-1.5">Combined with selected skills as context on every run.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-bg-secondary/50">
          <div>
            {onDelete && !confirmDelete && (
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-status-error hover:bg-status-error/10 rounded-md transition-colors cursor-pointer"
                onClick={() => setConfirmDelete(true)}
              >
                Delete agent
              </button>
            )}
            {onDelete && confirmDelete && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-status-error">Are you sure?</span>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm text-white bg-status-error rounded-md hover:bg-status-error/90 cursor-pointer"
                  onClick={() => { onDelete(); onClose() }}
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary cursor-pointer"
                  onClick={() => setConfirmDelete(false)}
                >
                  No
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-4 py-2 text-sm border border-border rounded-lg bg-bg-primary text-text-primary hover:bg-bg-tertiary transition-colors cursor-pointer"
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
              {saving ? 'Saving...' : isNew ? 'Create Agent' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
