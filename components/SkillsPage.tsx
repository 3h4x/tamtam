'use client'

import { useState, useEffect, useRef } from 'react'
import { fetchSkills, createSkill, updateSkill, deleteSkill } from '@/lib/client-api'
import type { Skill } from '@/lib/client-api'

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [creating, setCreating] = useState(false)

  const loadSkills = async () => {
    try {
      const data = await fetchSkills()
      setSkills(data.skills)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadSkills() }, [])

  const handleDelete = async (id: string) => {
    try {
      await deleteSkill(id)
      setSkills(prev => prev.filter(s => s.id !== id))
      if (editing?.id === id) setEditing(null)
    } catch {}
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">Skills</h2>
        <button
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
          onClick={() => { setCreating(true); setEditing(null) }}
        >
          + New Skill
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-text-secondary text-sm">
          <div className="spinner" />
          Loading skills…
        </div>
      ) : (
        <div className="flex gap-6">
          {/* Skill list */}
          <div className="w-72 shrink-0 flex flex-col gap-2">
            {skills.length === 0 && !creating && (
              <div className="text-text-secondary text-sm p-4 bg-bg-secondary rounded-lg border border-border">
                No custom skills yet. Create one to compose reusable instructions into your agents.
              </div>
            )}
            {skills.map(skill => (
              <div
                key={skill.id}
                className={`p-3 rounded-lg cursor-pointer border transition-colors ${
                  editing?.id === skill.id
                    ? 'border-accent bg-accent-light'
                    : 'border-border bg-bg-secondary hover:bg-bg-tertiary'
                }`}
                onClick={() => { setEditing(skill); setCreating(false) }}
              >
                <div className="font-medium text-sm text-text-primary">{skill.name}</div>
                {skill.description && (
                  <div className="text-xs text-text-secondary mt-1 truncate">{skill.description}</div>
                )}
              </div>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1">
            {creating && (
              <SkillEditor
                onSave={async (data) => {
                  const result = await createSkill(data)
                  setSkills(prev => [...prev, result.skill])
                  setEditing(result.skill)
                  setCreating(false)
                }}
                onCancel={() => setCreating(false)}
              />
            )}
            {editing && !creating && (
              <SkillEditor
                skill={editing}
                onSave={async (data) => {
                  const result = await updateSkill(editing.id, data)
                  setSkills(prev => prev.map(s => s.id === editing.id ? result.skill : s))
                  setEditing(result.skill)
                }}
                onDelete={() => handleDelete(editing.id)}
                onCancel={() => setEditing(null)}
              />
            )}
            {!editing && !creating && (
              <div className="text-text-secondary text-sm p-6 bg-bg-secondary rounded-lg text-center">
                Select a skill to edit or create a new one.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SkillEditor({
  skill,
  onSave,
  onDelete,
  onCancel,
}: {
  skill?: Skill
  onSave: (data: { name: string; description: string; content: string }) => Promise<void>
  onDelete?: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(skill?.name || '')
  const [description, setDescription] = useState(skill?.description || '')
  const [content, setContent] = useState(skill?.content || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setName(skill?.name || '')
    setDescription(skill?.description || '')
    setContent(skill?.content || '')
    setSaved(false)
  }, [skill?.id])

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
    <div className="bg-bg-secondary rounded-lg p-4 flex flex-col gap-4">
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
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
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

      <div className="flex-1">
        <label className="block mb-1 text-sm font-medium text-text-primary">
          Prompt Content
        </label>
        <textarea
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="The system prompt / instructions for this skill..."
          rows={16}
        />
      </div>
    </div>
  )
}
