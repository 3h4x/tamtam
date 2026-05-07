'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchProjectDocs } from '@/lib/client-api'
import type { Agent, Skill, Persona, ProjectDoc } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { MODEL_TIERS, MODEL_LABELS, MODEL_DESCRIPTIONS, normalizeModelInput } from '@/lib/agents/model-aliases'

const MODELS = [...MODEL_TIERS]
const RUNNERS = ['pm2', 'launchctl']
const SCHEDULES = ['', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h']

export function AgentModal({
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
  const [model, setModel] = useState(normalizeModelInput(agent?.model || template?.model, 'normal'))
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
    setModel(normalizeModelInput(src.model, 'normal'))
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
        className="bg-bg-primary rounded-lg shadow-lg border border-border w-full max-w-2xl flex flex-col animate-slide-in-up"
        style={{ maxHeight: '92vh' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
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
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4 min-h-0">

          {/* Row 1: Name + Model */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label htmlFor="agent-name" className="block mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Name</label>
              <input
                ref={nameRef}
                id="agent-name"
                type="text"
                className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
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
                  const label = MODEL_LABELS[m]
                  const desc = MODEL_DESCRIPTIONS[m]
                  const sel = model === m
                  return (
                    <button
                      key={m}
                      type="button"
                      title={desc}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all whitespace-nowrap ${
                        sel
                          ? 'bg-accent text-white shadow-sm'
                          : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                      }`}
                      onClick={() => setModel(m)}
                    >
                      {label}
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
              className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors font-mono resize-none"
              rows={6}
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
                          className={`w-full px-3 py-2 text-left border-none cursor-pointer transition-colors flex items-center gap-3 ${
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
                        className={`w-full px-3 py-2 text-left border-none cursor-pointer transition-colors flex items-center gap-3 ${
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
          <div className="flex items-center gap-4 px-3 py-2.5 rounded-lg bg-bg-secondary border border-border">
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
        <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
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
                  onClick={() => { onDelete(); onClose() }}
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
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="solid"
              onClick={handleSave}
              disabled={!name.trim() || saving}
            >
              {saving && <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0" />}
              {saving ? 'Saving…' : isNew ? 'Create Agent' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
