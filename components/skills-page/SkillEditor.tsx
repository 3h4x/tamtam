'use client'

import { useEffect, useRef, useState } from 'react'
import type { Skill } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

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
    // Reset only when the editor switches to a different skill (identity
    // change). Including `skill.name/description/content` in deps would
    // overwrite a user's unsaved edits whenever the parent re-fetches the
    // skill list — the same logical skill comes back with the saved-on-
    // server values, the effect fires, and the buffer the user was typing
    // in vanishes.
    baselineRef.current = { name: skill?.name || '', description: skill?.description || '', content: skill?.content || '' }
    setName(baselineRef.current.name)
    setDescription(baselineRef.current.description)
    setContent(baselineRef.current.content)
    setSaved(false)
    onDirtyChangeRef.current?.(false)
  }, [skill?.id])

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
      // Refresh the baseline to match the just-saved values. Without this,
      // the dep-tightened reset effect (id-only) never runs after save,
      // so a subsequent edit-and-revert-to-saved-value still compares
      // against the pre-save baseline and spuriously reports dirty=true,
      // producing a false "Discard unsaved changes?" confirm on close.
      baselineRef.current = { name, description, content }
      onDirtyChangeRef.current?.(false)
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
            <Button
              type="button"
              variant="danger"
              onClick={onDelete}
            >
              Delete
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
          >
            {skill ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            variant="solid"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving && <Spinner color="white" shrink />}
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </Button>
        </div>
      </div>

      <div>
        <label htmlFor="skill-name" className="block mb-1 text-sm font-medium text-text-primary">Name</label>
        <Input
          id="skill-name"
          ref={nameRef}
          type="text"
          inputSize="compact"
          paddingX="default"
          fontFamily="sans"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. security-reviewer"
        />
      </div>

      <div>
        <label htmlFor="skill-description" className="block mb-1 text-sm font-medium text-text-primary">Description</label>
        <Input
          id="skill-description"
          type="text"
          inputSize="compact"
          paddingX="default"
          fontFamily="sans"
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
