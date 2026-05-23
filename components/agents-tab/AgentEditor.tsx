'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { fetchProjectDocs, improveAgentPrompt } from '@/lib/client-api'
import type { Agent, Skill, Persona, ProjectDoc } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/Toast'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { MODEL_TIERS, MODEL_LABELS, MODEL_DESCRIPTIONS, normalizeModelInput } from '@/lib/agents/model-aliases'
import { resolveAgentPrerequisiteCommand } from '@/lib/agents/issue-cruncher'
import { CLI_PROVIDERS, type CliProvider } from '@/lib/usage/cli-providers'

const MODELS = [...MODEL_TIERS]
// `Manual` is rendered as a hardcoded <option value="">; SCHEDULES below is
// the non-empty list — dropped the leading '' sentinel + the .filter(Boolean)
// that used to mask it at render time.
const SCHEDULES = ['15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h', '3d', '7d', '30d']

export interface AgentEditorSavePayload {
  name: string
  prompt: string
  skillIds: string[]
  docPaths: string[]
  model: string
  schedule: string | null
  enabled: boolean
  provider: CliProvider | null
  fallbackEnabled?: boolean
  prerequisiteCommand: string | null
}

export function AgentEditor({
  agent,
  template,
  project,
  skills,
  personas,
  onSave,
  onDelete,
  onBack,
}: {
  agent?: Agent
  template?: AgentTemplateRecord
  project: string
  skills: Skill[]
  personas: Persona[]
  onSave: (data: AgentEditorSavePayload) => Promise<void>
  onDelete?: () => void
  onBack: () => void
}) {
  const initialSkillIds = agent?.skillIds || template?.skillIds || []
  const initialPrerequisite = agent
    ? (agent.prerequisiteCommand ?? '')
    : (resolveAgentPrerequisiteCommand({
        project,
        skillIds: initialSkillIds,
        prerequisiteCommand: null,
      }) ?? '')
  const [name, setName] = useState(agent?.name || template?.name || '')
  const [agentPrompt, setAgentPrompt] = useState(agent?.prompt || template?.prompt || '')
  const [selectedSkills, setSelectedSkills] = useState<string[]>(initialSkillIds)
  const [selectedDocPaths, setSelectedDocPaths] = useState<string[]>(agent?.docPaths || [])
  const [availableDocs, setAvailableDocs] = useState<ProjectDoc[]>([])
  const [contextTab, setContextTab] = useState<'skills' | 'docs'>('skills')
  const [model, setModel] = useState(normalizeModelInput(agent?.model || template?.model, 'normal'))
  const [provider, setProvider] = useState<CliProvider | null>((agent?.provider as CliProvider | null | undefined) ?? null)
  const [fallbackEnabled, setFallbackEnabled] = useState<boolean>(agent?.fallbackEnabled ?? template?.fallbackEnabled ?? false)
  const [schedule, setSchedule] = useState(agent?.schedule || template?.schedule || '')
  const [enabled, setEnabled] = useState<boolean>(agent ? agent.enabled : true)
  const [prerequisiteCommand, setPrerequisiteCommand] = useState<string>(initialPrerequisite)
  const [saving, setSaving] = useState(false)
  const [improving, setImproving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  // System agents are auto-managed: their identity (name, prompt, skills,
  // docs, model, provider) is owned by TamTam. Only the schedule and
  // enabled toggles are user-tunable.
  const isSystemAgent = agent?.kind === 'system'

  // Memoize allItems + the id→item lookup since they only change when
  // skills/personas reload (rare) — the selected-chip render below was
  // doing O(K × M) .find() per render for K selected and M total items.
  const allItems = useMemo(() => [
    ...skills.map(s => ({ id: s.id, name: s.name, description: s.description, source: 'db' as const })),
    ...personas.map(p => ({ id: `persona:${p.path}`, name: `${p.emoji ? p.emoji + ' ' : ''}${p.name}`, description: `${p.category}${p.description ? ' — ' + p.description : ''}`, source: 'file' as const })),
  ], [skills, personas])
  const itemById = useMemo(() => new Map(allItems.map(i => [i.id, i])), [allItems])
  const docByPath = useMemo(() => new Map(availableDocs.map(d => [d.path, d])), [availableDocs])

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
    setModel(normalizeModelInput(src.model, 'normal'))
    setProvider((agent?.provider as CliProvider | null | undefined) ?? null)
    setFallbackEnabled(agent?.fallbackEnabled ?? template?.fallbackEnabled ?? false)
    setSchedule(src.schedule || '')
    if (agent) setEnabled(agent.enabled)
    setPrerequisiteCommand(agent
      ? (agent.prerequisiteCommand ?? '')
      : (resolveAgentPrerequisiteCommand({
          project,
          skillIds: src.skillIds || [],
          prerequisiteCommand: null,
        }) ?? ''))
  }, [agent?.id, project, template?.name])

  useEffect(() => {
    if (!agent) nameRef.current?.focus()
  }, [])

  const toggleSkill = (skillId: string) => {
    if (isSystemAgent) return
    setSelectedSkills(prev =>
      prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]
    )
  }

  const toggleDoc = (path: string) => {
    if (isSystemAgent) return
    setSelectedDocPaths(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    )
  }

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ name, prompt: agentPrompt, skillIds: selectedSkills, docPaths: selectedDocPaths, model, schedule: schedule || null, enabled, provider, fallbackEnabled, prerequisiteCommand: prerequisiteCommand.trim() || null })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save agent', 'error')
    }
    setSaving(false)
  }

  const handleImprove = async () => {
    const draft = agentPrompt.trim()
    if (isSystemAgent || improving || draft.length < 3) return
    setImproving(true)
    try {
      const result = await improveAgentPrompt({
        project,
        draftPrompt: draft,
        skillIds: selectedSkills,
        docPaths: selectedDocPaths,
      })
      if (result.improvedPrompt) setAgentPrompt(result.improvedPrompt)
      toast('Prompt improved (Cmd+Z to undo)', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to improve prompt', 'error')
    } finally {
      setImproving(false)
    }
  }

  const isNew = !agent

  return (
    <div className="mx-auto w-full max-w-4xl px-2 py-4 flex flex-col gap-4">
      {/* Header strip */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            ← Back to agents
          </button>
          <span className="text-text-tertiary">/</span>
          <h2 className="text-base font-semibold text-text-primary truncate">
            {isNew ? 'New agent' : `Edit — ${agent.name}`}
          </h2>
        </div>
      </div>

      {isSystemAgent && (
        <div className="px-3 py-2 text-xs rounded-md border border-accent/30 bg-accent/10 text-text-secondary">
          <span className="font-semibold text-accent">Built-in system agent.</span>{' '}
          Identity, behavior, and schedule are managed by TamTam. You can
          disable it here; the schedule is set globally from Settings →
          Retrieval. Deleting removes it for this project until you re-enable
          in Settings.
        </div>
      )}

      {/* Row 1: Name + Model + Provider */}
      <div className="flex gap-4 items-end flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="agent-name" className="block mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Name</label>
          <input
            ref={nameRef}
            id="agent-name"
            type="text"
            className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) handleSave() }}
            placeholder="e.g. security-guard"
            disabled={isSystemAgent}
            title={isSystemAgent ? 'Built-in agent name is fixed' : undefined}
          />
        </div>
        <div className="shrink-0">
          <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Model</div>
          <div className="flex gap-px p-0.5 rounded-lg bg-bg-secondary border border-border">
            {MODELS.map(m => {
              const label = MODEL_LABELS[m]
              const desc = MODEL_DESCRIPTIONS[m]
              const sel = model === m
              return (
                <button
                  key={m}
                  type="button"
                  title={desc}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed ${
                    sel
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                  }`}
                  onClick={() => setModel(m)}
                  disabled={isSystemAgent}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="shrink-0">
          <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Provider</div>
          <div className="flex gap-px p-0.5 rounded-lg bg-bg-secondary border border-border">
            <button
              type="button"
              className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed ${
                provider === null
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
              }`}
              onClick={() => setProvider(null)}
              disabled={isSystemAgent}
              title={isSystemAgent ? 'Built-in agent provider is fixed' : 'Let TamTam choose any healthy enabled provider at run time'}
            >
              any
            </button>
            {CLI_PROVIDERS.map((cliProvider) => {
              const selected = provider === cliProvider
              return (
                <button
                  key={cliProvider}
                  type="button"
                  className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed ${
                    selected
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                  }`}
                  onClick={() => setProvider(cliProvider)}
                  disabled={isSystemAgent}
                  title={isSystemAgent ? 'Built-in agent provider is fixed' : `Require ${cliProvider} for this agent. If it is unavailable or over budget, the run will not start.`}
                >
                  {cliProvider}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Prompt */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5 gap-2">
          <label htmlFor="agent-prompt" className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Prompt</span>
            {selectedSkills.length > 0 && (
              <span className="text-xs text-text-tertiary font-normal normal-case">optional — skills define default behavior</span>
            )}
          </label>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleImprove}
            disabled={isSystemAgent || improving || agentPrompt.trim().length < 3}
            title={isSystemAgent ? 'Built-in agent prompt is fixed' : 'Rewrite this prompt using project context (CLAUDE.md + selected skills/docs)'}
            className="rounded-md text-text-secondary hover:text-accent hover:border-accent/40"
          >
            {improving
              ? <Spinner color="accent" />
              : null}
            <span>{improving ? 'Improving…' : 'Improve'}</span>
          </Button>
        </div>
        <textarea
          id="agent-prompt"
          className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors font-mono resize-y disabled:opacity-60 disabled:cursor-not-allowed"
          rows={10}
          value={agentPrompt}
          onChange={(e) => setAgentPrompt(e.target.value)}
          placeholder={selectedSkills.length > 0
            ? 'Optional: repo-specific hints to append to the skill (e.g. "focus on lib/auth").'
            : 'What should this agent do when it runs?'}
          disabled={isSystemAgent}
          title={isSystemAgent ? 'Built-in agent prompt is fixed' : undefined}
        />
      </div>

      {/* Prerequisite command */}
      <div>
        <label htmlFor="agent-prerequisite" className="flex items-baseline gap-2 mb-1.5">
          <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Prerequisite Command</span>
          <span className="text-xs text-text-tertiary font-normal normal-case">optional — runs before the agent; output injected into the prompt</span>
        </label>
        <input
          id="agent-prerequisite"
          type="text"
          className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors font-mono disabled:opacity-60 disabled:cursor-not-allowed"
          value={prerequisiteCommand}
          onChange={(e) => setPrerequisiteCommand(e.target.value)}
          placeholder="e.g. pnpm test"
          disabled={isSystemAgent}
          title={isSystemAgent ? 'Built-in agent prerequisite is fixed' : undefined}
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

        {(selectedSkills.length > 0 || selectedDocPaths.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {selectedSkills.map(id => {
              const item = itemById.get(id)
              return (
                <span key={id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded-full bg-accent/15 text-accent border border-accent/25 font-medium">
                  {item?.name || id}
                  {!isSystemAgent && (
                    <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-accent/20 cursor-pointer opacity-60 hover:opacity-100 transition-opacity" onClick={() => toggleSkill(id)}>×</button>
                  )}
                </span>
              )
            })}
            {selectedDocPaths.map(path => {
              const doc = docByPath.get(path)
              return (
                <span key={path} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded-full border border-status-success/30 bg-status-success/10 text-status-success font-medium">
                  {doc?.name || path}
                  {!isSystemAgent && (
                    <button type="button" className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-status-success/20 cursor-pointer opacity-60 hover:opacity-100 transition-opacity" onClick={() => toggleDoc(path)}>×</button>
                  )}
                </span>
              )
            })}
          </div>
        )}

        {contextTab === 'skills' && (
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              value={skillSearch}
              onChange={(e) => setSkillSearch(e.target.value)}
              placeholder="Search skills and personas..."
              disabled={isSystemAgent}
            />
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {filteredItems.length === 0 ? (
                <div className="px-4 py-3 text-sm text-text-tertiary text-center">No matches</div>
              ) : (
                filteredItems.slice(0, 60).map(item => {
                  const isSelected = selectedSkills.includes(item.id)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`w-full px-3 py-2 text-left border-none cursor-pointer transition-colors flex items-center gap-3 disabled:cursor-not-allowed disabled:opacity-70 ${
                        isSelected ? 'bg-accent/8 text-text-primary' : 'bg-transparent text-text-primary hover:bg-bg-secondary'
                      }`}
                      onClick={() => toggleSkill(item.id)}
                      disabled={isSystemAgent}
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

        {contextTab === 'docs' && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {availableDocs.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-tertiary text-center">No docs found for this project</div>
            ) : (
              availableDocs.map(doc => {
                const isSelected = selectedDocPaths.includes(doc.path)
                return (
                  <button
                    key={doc.path}
                    type="button"
                    className={`w-full px-3 py-2 text-left border-none cursor-pointer transition-colors flex items-center gap-3 disabled:cursor-not-allowed disabled:opacity-70 ${
                      isSelected ? 'bg-status-success/8 text-text-primary' : 'bg-transparent text-text-primary hover:bg-bg-secondary'
                    }`}
                    onClick={() => toggleDoc(doc.path)}
                    disabled={isSystemAgent}
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

      {/* Settings strip: Schedule / Enabled */}
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
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 -mx-2 px-2 py-3 border-t border-border bg-bg-primary/95 backdrop-blur flex items-center justify-between">
        <div>
          {onDelete && !confirmDelete && (
            <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          {onDelete && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-status-error">Delete this agent?</span>
              <Button
                type="button"
                variant="danger-solid"
                onClick={() => { onDelete(); onBack() }}
              >
                Delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="solid"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving && <Spinner color="white" shrink />}
            {saving ? 'Saving…' : isNew ? 'Create agent' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
