'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchSkillRevisions, revertSkill } from '@/lib/client-api'
import type { Skill, SkillRevision } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { Input } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Textarea } from '@/components/ui/Textarea'
import { Spinner } from '@/components/ui/Spinner'

export function SkillEditor({
  skill,
  onSave,
  onDelete,
  onCancel,
  onDirtyChange,
  onReverted,
}: {
  skill?: Skill
  onSave: (data: { name: string; description: string; content: string }) => Promise<void>
  onDelete?: () => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
  onReverted?: (skill: Skill) => void
}) {
  const [name, setName] = useState(skill?.name || '')
  const [description, setDescription] = useState(skill?.description || '')
  const [content, setContent] = useState(skill?.content || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mode, setMode] = useState<'edit' | 'history'>('edit')
  const [revisions, setRevisions] = useState<SkillRevision[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [revertingId, setRevertingId] = useState<number | null>(null)
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
    setMode('edit')
    setRevisions([])
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

  const loadHistory = async () => {
    if (!skill || historyLoading) return
    setHistoryLoading(true)
    try {
      const result = await fetchSkillRevisions(skill.id)
      setRevisions(result.revisions)
    } finally {
      setHistoryLoading(false)
    }
  }

  const openHistory = () => {
    setMode('history')
    void loadHistory()
  }

  const handleModeChange = (nextMode: 'edit' | 'history') => {
    if (nextMode === 'history') {
      openHistory()
    } else {
      setMode('edit')
    }
  }

  const handleRevert = async (revisionId: number) => {
    if (!skill || revertingId !== null) return
    setRevertingId(revisionId)
    try {
      const result = await revertSkill(skill.id, revisionId)
      setName(result.skill.name)
      setDescription(result.skill.description)
      setContent(result.skill.content)
      baselineRef.current = {
        name: result.skill.name,
        description: result.skill.description,
        content: result.skill.content,
      }
      onDirtyChangeRef.current?.(false)
      onReverted?.(result.skill)
      const history = await fetchSkillRevisions(skill.id)
      setRevisions(history.revisions)
      setMode('edit')
    } finally {
      setRevertingId(null)
    }
  }

  return (
    <div className="bg-bg-secondary rounded-lg p-4 flex flex-col gap-4 border border-border">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          {skill ? 'Edit Skill' : 'New Skill'}
        </h3>
        <div className="flex items-center gap-2">
          {skill && (
            <SegmentedControl
              ariaLabel="Skill editor mode"
              value={mode}
              onChange={handleModeChange}
              options={[
                { value: 'edit', label: 'Edit' },
                { value: 'history', label: 'History' },
              ]}
            />
          )}
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

      {mode === 'edit' ? (
        <>
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
            <Textarea
              id="skill-content"
              appearance="muted"
              className="h-[60vh] min-h-[240px]"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="The system prompt / instructions for this skill..."
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {historyLoading ? (
            <InlineLoading label="Loading history…" />
          ) : revisions.length === 0 ? (
            <div className="text-sm text-text-secondary">No revisions recorded yet.</div>
          ) : revisions.map((revision) => {
            const snap = revision.parsedSnapshot
            return (
              <div key={revision.id} className="rounded-md border border-border bg-bg-primary p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">
                      Revision {revision.id}
                    </div>
                    <div className="text-xs text-text-tertiary">
                      {new Date(revision.createdAt * 1000).toLocaleString()} · {revision.author}
                      {revision.note ? ` · ${revision.note}` : ''}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!snap || revertingId !== null}
                    onClick={() => handleRevert(revision.id)}
                  >
                    {revertingId === revision.id ? 'Reverting…' : 'Revert'}
                  </Button>
                </div>
                {snap && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <div className="mb-1 text-xs font-semibold text-text-tertiary uppercase">Then</div>
                      <pre className="max-h-64 overflow-auto rounded-md bg-bg-secondary p-2 text-xs text-text-secondary whitespace-pre-wrap">{snap.content}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold text-text-tertiary uppercase">Now</div>
                      <pre className="max-h-64 overflow-auto rounded-md bg-bg-secondary p-2 text-xs text-text-secondary whitespace-pre-wrap">{content}</pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
