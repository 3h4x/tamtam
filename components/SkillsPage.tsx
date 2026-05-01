'use client'

import { useState, useEffect, useRef } from 'react'
import { fetchSkills, createSkill, updateSkill, deleteSkill, fetchProjects, createAgent, fetchAgents } from '@/lib/client-api'
import type { Skill } from '@/lib/client-api'

export function partitionSkillsForBulkCreate(
  skills: Skill[],
  existingAgentNames: Set<string>,
): { toCreate: Skill[]; toSkip: Skill[] } {
  const toCreate: Skill[] = []
  const toSkip: Skill[] = []
  for (const skill of skills) {
    if (existingAgentNames.has(displayName(skill))) toSkip.push(skill)
    else toCreate.push(skill)
  }
  return { toCreate, toSkip }
}

const SUGGESTED_SCHEDULES: Record<string, string> = {
  'agent-security-review': '24h',
  'agent-dependency-check': '24h',
  'agent-ci-monitor': '1h',
  'agent-blog': '24h',
  'agent-release-ready': '',
  'agent-cto': '',
  'agent-gha-audit': '24h',
  'agent-readme-sync': '24h',
  'agent-docs-claude': '24h',
  'agent-tests': '24h',
  'agent-self-improve': '',
  'agent-senior-fullstack': '',
}

function SkillIcon({ id, className = 'w-4 h-4' }: { id: string; className?: string }) {
  const props = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className }
  switch (id) {
    case 'agent-security-review':
      return <svg {...props}><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none"/></svg>
    case 'agent-dependency-check':
      return <svg {...props}><path d="M8 2L14 5.5V10.5L8 14L2 10.5V5.5L8 2Z"/><path d="M8 2v12"/><path d="M2 5.5l6 3.5 6-3.5"/></svg>
    case 'agent-ci-monitor':
      return <svg {...props}><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>
    case 'agent-blog':
      return <svg {...props}><path d="M11.5 2.5L13.5 4.5L6 12H4v-2l7.5-7.5z"/><path d="M2 14h12"/></svg>
    case 'agent-release-ready':
      return <svg {...props}><path d="M8 2C8 2 11.5 4.5 11.5 8.5c0 1-.3 1.8-.3 1.8L8 12l-3.2-1.7S4.5 9.5 4.5 8.5C4.5 4.5 8 2 8 2z"/><circle cx="8" cy="8.5" r="1.5"/><path d="M4.8 11.5L3 13.5M11.2 11.5L13 13.5"/></svg>
    case 'agent-cto':
      return <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M10.2 5.8L9 9 5.8 10.2 7 7z"/></svg>
    case 'agent-gha-audit':
      return <svg {...props}><path d="M13 3a3 3 0 0 1-4 4L5.5 10.5A1.5 1.5 0 1 0 7.5 12.5L11 9a3 3 0 0 1 4-4L13.5 6.5 11 4z"/></svg>
    case 'agent-readme-sync':
      return <svg {...props}><path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L9.5 2z"/><path d="M9.5 2V6.5H14"/><path d="M5 9.5h6M5 12h4"/></svg>
    case 'agent-tests':
      return <svg {...props}><path d="M5.5 2h5v3L13 8.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5L5.5 5z"/><path d="M6.5 9.5l1.2 1.2L10 8.3"/></svg>
    case 'agent-self-improve':
      return <svg {...props}><path d="M8 1.5L9.5 5h3.5l-2.8 2 1 3.5L8 8.5 4.8 10.5l1-3.5L3 5h3.5z"/></svg>
    case 'agent-docs-claude':
      return <svg {...props}><path d="M3 3h10v10H3z"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/><path d="M11 1.5v3h3"/><path d="M11 1.5L14 4.5"/></svg>
    case 'agent-senior-fullstack':
      return <svg {...props}><path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4"/><path d="M9.5 2.5l-3 11"/></svg>
    default:
      return <svg {...props}><circle cx="8" cy="8" r="5"/></svg>
  }
}

function isRecommended(skill: Skill) {
  return skill.id.startsWith('agent-')
}

function displayName(skill: Skill) {
  return skill.name.startsWith('agent:') ? skill.name.slice('agent:'.length) : skill.name
}

interface SkillRowProps {
  skill: Skill
  checked: boolean
  onToggle: () => void
  onEdit?: () => void
}

function SkillRow({ skill, checked, onToggle, onEdit }: SkillRowProps) {
  const recommended = isRecommended(skill)
  const schedule = SUGGESTED_SCHEDULES[skill.id]

  return (
    <label
      className="grid items-center gap-x-3 px-4 py-3 cursor-pointer hover:bg-bg-tertiary/50 transition-colors group"
      style={{ gridTemplateColumns: '1rem 1rem 10rem 6rem 1fr auto' }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="w-4 h-4 rounded border-border accent-accent cursor-pointer"
      />

      {/* Icon */}
      <span className="text-text-tertiary flex items-center justify-center">
        <SkillIcon id={skill.id} />
      </span>

      {/* Name */}
      <span className="text-sm font-semibold text-text-primary truncate">
        {displayName(skill)}
      </span>

      {/* Schedule */}
      <div>
        {recommended && schedule && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-bg-primary border border-border text-text-secondary font-medium whitespace-nowrap">
            every {schedule}
          </span>
        )}
        {recommended && !schedule && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-bg-primary border border-border text-text-tertiary font-medium whitespace-nowrap">manual</span>
        )}
      </div>

      {/* Description */}
      <span className="text-xs text-text-secondary truncate min-w-0">
        {skill.description || <span className="text-text-tertiary italic">No description</span>}
      </span>

      {/* Edit */}
      {onEdit ? (
        <button
          className="px-2 py-1 text-xs border border-border rounded text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer"
          onClick={e => { e.preventDefault(); e.stopPropagation(); onEdit() }}
        >
          Edit
        </button>
      ) : <span />}
    </label>
  )
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [projects, setProjects] = useState<string[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [bulkCreating, setBulkCreating] = useState(false)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const bulkResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadSkills = async () => {
    try {
      const data = await fetchSkills()
      setSkills(data.skills)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadSkills() }, [])

  useEffect(() => {
    fetchProjects().then(data => {
      const names = data.tasks.map(t => t.project).filter((v, i, a) => a.indexOf(v) === i).sort()
      setProjects(names)
      setProjectsError(null)
      if (names.length > 0) setSelectedProject(names[0])
    }).catch(err => {
      console.error('Failed to load projects', err)
      setProjectsError('Failed to load projects')
    })
  }, [])

  const handleDelete = async (id: string) => {
    try {
      await deleteSkill(id)
      setSkills(prev => prev.filter(s => s.id !== id))
      setSelected(prev => { const next = new Set(prev); next.delete(id); return next })
      if (editing?.id === id) setEditing(null)
    } catch {}
  }

  const toggleAll = (skillSubset: Skill[]) => {
    const ids = skillSubset.map(s => s.id)
    setSelected(prev => {
      const allChecked = ids.every(id => prev.has(id))
      const next = new Set(prev)
      if (allChecked) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }

  const handleBulkCreate = async () => {
    if (!selectedProject || selected.size === 0 || bulkCreating) return
    setBulkCreating(true)
    setBulkResult(null)

    const selectedSkills = skills.filter(s => selected.has(s.id))
    let existingNames = new Set<string>()
    try {
      const { agents } = await fetchAgents(selectedProject)
      existingNames = new Set(agents.map(a => a.name))
    } catch (err) {
      console.error('Failed to fetch existing agents for dedup', err)
    }
    const { toCreate, toSkip } = partitionSkillsForBulkCreate(selectedSkills, existingNames)
    let created = 0
    let failed = 0
    const skipped = toSkip.length
    for (const skill of toCreate) {
      const agentName = displayName(skill)
      try {
        await createAgent({
          name: agentName,
          project: selectedProject,
          skillIds: [skill.id],
          model: 'sonnet',
          prompt: skill.description || '',
          schedule: SUGGESTED_SCHEDULES[skill.id] || null,
          runner: 'pm2',
        })
        created++
      } catch {
        failed++
      }
    }
    setBulkCreating(false)
    const parts: string[] = []
    parts.push(`${created} created`)
    if (skipped > 0) parts.push(`${skipped} skipped (already exist)`)
    if (failed > 0) parts.push(`${failed} failed`)
    setBulkResult(`${parts.join(', ')} for ${selectedProject}`)
    setSelected(new Set())
    if (bulkResultTimer.current) clearTimeout(bulkResultTimer.current)
    bulkResultTimer.current = setTimeout(() => setBulkResult(null), 4000)
  }

  useEffect(() => () => {
    if (bulkResultTimer.current) clearTimeout(bulkResultTimer.current)
  }, [])

  const closeEditor = () => {
    if (editorDirty && !confirm('Discard unsaved changes?')) return
    setCreating(false)
    setEditing(null)
    setEditorDirty(false)
  }

  const confirmSwitchEditor = () => {
    if (editorDirty && !confirm('Discard unsaved changes?')) return false
    setEditorDirty(false)
    return true
  }

  const openNewSkill = () => {
    if (!confirmSwitchEditor()) return
    setCreating(true)
    setEditing(null)
  }

  const openEditSkill = (skill: Skill) => {
    if (!confirmSwitchEditor()) return
    setEditing(skill)
    setCreating(false)
  }

  const recommended = skills.filter(isRecommended)
  const custom = skills.filter(s => !isRecommended(s))
  const recommendedAllChecked = recommended.length > 0 && recommended.every(s => selected.has(s.id))
  const recommendedSomeChecked = recommended.some(s => selected.has(s.id))
  const customAllChecked = custom.length > 0 && custom.every(s => selected.has(s.id))
  const customSomeChecked = custom.some(s => selected.has(s.id))

  if (loading) {
    return (
      <div className="p-6 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Skills</h2>
            <p className="text-sm text-text-tertiary mt-0.5">Select skills, pick a project, and create agents in bulk.</p>
          </div>
          <div className="skeleton h-8 w-28 rounded-md" />
        </div>
        {[6, 2].map((rows, sectionIdx) => (
          <section key={sectionIdx}>
            <div className="flex items-center gap-3 mb-1 px-4">
              <div className="skeleton h-4 w-4 rounded" />
              <div className="skeleton h-3 w-24 rounded" />
            </div>
            <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
              {Array.from({ length: rows }).map((_, i) => (
                <div
                  key={i}
                  className="grid items-center gap-x-3 px-4 py-3"
                  style={{ gridTemplateColumns: '1rem 1rem 10rem 6rem 1fr auto', opacity: 1 - i * 0.1 }}
                >
                  <div className="skeleton h-4 w-4 rounded" />
                  <div className="skeleton h-4 w-4 rounded" />
                  <div className="skeleton h-4 w-32 rounded" />
                  <div className="skeleton h-5 w-16 rounded-full" />
                  <div className="skeleton h-3 w-full rounded" />
                  <div className="skeleton h-6 w-12 rounded" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 pb-24">
      {/* Editor overlay */}
      {(creating || editing) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closeEditor}>
          <div className="w-full max-w-2xl mx-4" onClick={e => e.stopPropagation()}>
            <SkillEditor
              skill={editing ?? undefined}
              onDirtyChange={setEditorDirty}
              onSave={async (data) => {
                if (creating) {
                  const result = await createSkill(data)
                  setSkills(prev => [...prev, result.skill])
                  setEditing(result.skill)
                  setCreating(false)
                } else if (editing) {
                  const result = await updateSkill(editing.id, data)
                  setSkills(prev => prev.map(s => s.id === editing.id ? result.skill : s))
                  setEditing(result.skill)
                }
                setEditorDirty(false)
              }}
              onDelete={editing ? () => handleDelete(editing.id) : undefined}
              onCancel={closeEditor}
            />
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Skills</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Select skills, pick a project, and create agents in bulk.</p>
        </div>
        <button
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
          onClick={openNewSkill}
        >
          + New Skill
        </button>
      </div>

      {/* Recommended section */}
      {recommended.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-1 px-4">
            <input
              type="checkbox"
              checked={recommendedAllChecked}
              ref={el => { if (el) el.indeterminate = !recommendedAllChecked && recommendedSomeChecked }}
              onChange={() => toggleAll(recommended)}
              className="w-4 h-4 rounded border-border accent-accent cursor-pointer"
            />
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Recommended</h3>
          </div>
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
            {recommended.map(skill => (
              <SkillRow
                key={skill.id}
                skill={skill}
                checked={selected.has(skill.id)}
                onToggle={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(skill.id)) next.delete(skill.id)
                  else next.add(skill.id)
                  return next
                })}
                onEdit={() => openEditSkill(skill)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Custom skills section */}
      <section>
        <div className="flex items-center gap-3 mb-1 px-4">
          {custom.length > 0 && (
            <input
              type="checkbox"
              checked={customAllChecked}
              ref={el => { if (el) el.indeterminate = !customAllChecked && customSomeChecked }}
              onChange={() => toggleAll(custom)}
              className="w-4 h-4 rounded border-border accent-accent cursor-pointer"
            />
          )}
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Custom Skills</h3>
        </div>
        {custom.length === 0 ? (
          <div className="text-text-secondary text-sm p-6 bg-bg-secondary rounded-lg border border-border text-center">
            <p>No custom skills yet.</p>
            <p className="text-xs text-text-tertiary mt-1">Use <span className="font-medium">+ New Skill</span> to create one.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
            {custom.map(skill => (
              <SkillRow
                key={skill.id}
                skill={skill}
                checked={selected.has(skill.id)}
                onToggle={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(skill.id)) next.delete(skill.id)
                  else next.add(skill.id)
                  return next
                })}
                onEdit={() => openEditSkill(skill)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Toast — rendered independently of the sticky bar so bulk-create feedback remains visible after the selection is cleared */}
      {bulkResult && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-md border border-border bg-bg-secondary shadow-lg text-sm text-status-success font-medium" role="status" aria-live="polite">
          {bulkResult}
        </div>
      )}

      {/* Sticky action bar — slides up when skills are selected */}
      <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-200 ${selected.size > 0 ? 'translate-y-0' : 'translate-y-full'}`}>
        <div className="border-t border-border bg-bg-secondary/95 backdrop-blur-sm px-6 py-3 flex items-center gap-4">
          <span className="text-sm text-text-secondary shrink-0">
            <span className="font-semibold text-text-primary">{selected.size}</span> skill{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex-1" />
          {projectsError && (
            <span className="text-xs text-status-error font-medium">{projectsError}</span>
          )}
          <label className="text-xs text-text-secondary shrink-0">Create agents for</label>
          <select
            className="px-2 py-1.5 text-sm bg-bg-tertiary border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.length === 0
              ? <option value="">{projectsError ? 'Failed to load projects' : 'No projects available'}</option>
              : projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            className="px-4 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 shrink-0"
            onClick={handleBulkCreate}
            disabled={bulkCreating || !selectedProject}
          >
            {bulkCreating ? 'Creating…' : 'Create Agents'}
          </button>
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer shrink-0"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}

function SkillEditor({
  skill,
  onSave,
  onDelete,
  onCancel,
  onDirtyChange,
}: {
  skill?: Skill
  onSave: (data: { name: string; description: string; content: string }) => Promise<void>
  onDelete?: () => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [name, setName] = useState(skill?.name || '')
  const [description, setDescription] = useState(skill?.description || '')
  const [content, setContent] = useState(skill?.content || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const baselineRef = useRef({ name: skill?.name || '', description: skill?.description || '', content: skill?.content || '' })
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])

  useEffect(() => {
    baselineRef.current = { name: skill?.name || '', description: skill?.description || '', content: skill?.content || '' }
    setName(baselineRef.current.name)
    setDescription(baselineRef.current.description)
    setContent(baselineRef.current.content)
    setSaved(false)
    onDirtyChangeRef.current?.(false)
  }, [skill?.id, skill?.name, skill?.description, skill?.content])

  useEffect(() => {
    const b = baselineRef.current
    const dirty = name !== b.name || description !== b.description || content !== b.content
    onDirtyChangeRef.current?.(dirty)
  }, [name, description, content])

  useEffect(() => {
    if (!skill) nameRef.current?.focus()
  }, [])

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ name, description, content })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {}
    setSaving(false)
  }

  return (
    <div className="bg-bg-secondary rounded-lg p-4 flex flex-col gap-4 border border-border">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          {skill ? 'Edit Skill' : 'New Skill'}
        </h3>
        <div className="flex items-center gap-2">
          {onDelete && (
            <button
              className="px-3 py-1.5 text-sm text-status-error border border-status-error rounded-md hover:bg-status-error/10 cursor-pointer"
              onClick={onDelete}
            >
              Delete
            </button>
          )}
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={onCancel}
          >
            {skill ? 'Close' : 'Cancel'}
          </button>
          <button
            className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      <div>
        <label className="block mb-1 text-sm font-medium text-text-primary">Name</label>
        <input
          ref={nameRef}
          type="text"
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. security-reviewer"
        />
      </div>

      <div>
        <label className="block mb-1 text-sm font-medium text-text-primary">Description</label>
        <input
          type="text"
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description of what this skill does"
        />
      </div>

      <div className="flex flex-col min-h-0">
        <label className="block mb-1 text-sm font-medium text-text-primary">Prompt Content</label>
        <textarea
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors h-[60vh] min-h-[240px]"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="The system prompt / instructions for this skill..."
        />
      </div>
    </div>
  )
}
