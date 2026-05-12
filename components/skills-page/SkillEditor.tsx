'use client'

import { useEffect, useRef, useState } from 'react'
import type { Skill } from '@/lib/client-api'

export function SkillEditor({
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
  }, [skill])

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
            className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer inline-flex items-center gap-1.5"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving && <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0" />}
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="skill-name" className="block mb-1 text-sm font-medium text-text-primary">Name</label>
        <input
          id="skill-name"
          ref={nameRef}
          type="text"
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. security-reviewer"
        />
      </div>

      <div>
        <label htmlFor="skill-description" className="block mb-1 text-sm font-medium text-text-primary">Description</label>
        <input
          id="skill-description"
          type="text"
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description of what this skill does"
        />
      </div>

      <div className="flex flex-col min-h-0">
        <label htmlFor="skill-content" className="block mb-1 text-sm font-medium text-text-primary">Prompt Content</label>
        <textarea
          id="skill-content"
          className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors h-[60vh] min-h-[240px]"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="The system prompt / instructions for this skill..."
        />
      </div>
    </div>
  )
}
