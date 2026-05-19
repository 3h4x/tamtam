'use client'

import { useState } from 'react'
import { MODEL_TIERS, MODEL_LABELS, normalizeModelInput } from '@/lib/agents/model-aliases'

export interface AgentTemplateRecord {
  name: string
  description: string
  model: string
  schedule: string
  prompt: string
  skillIds?: string[]
  fallbackEnabled?: boolean
}

const TEMPLATE_MODELS = [...MODEL_TIERS]
const TEMPLATE_SCHEDULES = ['', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h', '3d', '7d', '30d']

const EMPTY_TEMPLATE: AgentTemplateRecord = { name: '', description: '', model: 'normal', schedule: '24h', prompt: '' }

function TemplateForm({
  form, setField, onSave, onCancel, isEdit,
}: {
  form: AgentTemplateRecord
  setField: (k: keyof AgentTemplateRecord, v: string) => void
  onSave: () => void
  onCancel: () => void
  isEdit: boolean
}) {
  return (
    <div className="p-4 rounded-lg border border-accent/30 bg-accent/5 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setField('name', e.target.value)}
            placeholder="e.g. security-review"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            placeholder="Short description shown in the list"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Model</label>
          <select
            value={form.model}
            onChange={e => setField('model', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            {TEMPLATE_MODELS.map(m => <option key={m} value={m}>{MODEL_LABELS[m]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-primary mb-1">Schedule</label>
          <select
            value={form.schedule}
            onChange={e => setField('schedule', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            <option value="">Manual</option>
            {TEMPLATE_SCHEDULES.filter(Boolean).map(s => <option key={s} value={s}>every {s}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-primary mb-1">Prompt</label>
        <textarea
          value={form.prompt}
          onChange={e => setField('prompt', e.target.value)}
          placeholder="What should this agent do when it runs?"
          rows={4}
          className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent font-mono resize-y"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={!form.name.trim()}
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isEdit ? 'Save' : 'Add Template'}
        </button>
      </div>
    </div>
  )
}

export function AgentTemplatesTab({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parse = (v: string): AgentTemplateRecord[] => {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed)
        ? parsed.map((template) => ({ ...template, model: normalizeModelInput(template?.model, 'normal') }))
        : []
    } catch {
      return []
    }
  }
  const [templates, setTemplates] = useState<AgentTemplateRecord[]>(() => parse(value))
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<AgentTemplateRecord>(EMPTY_TEMPLATE)

  const commit = (next: AgentTemplateRecord[]) => {
    setTemplates(next)
    onChange(next.length ? JSON.stringify(next) : '')
  }

  const openNew = () => { setForm(EMPTY_TEMPLATE); setEditing('new') }
  const openEdit = (i: number) => { setForm(templates[i]); setEditing(i) }
  const cancel = () => setEditing(null)

  const save = () => {
    if (!form.name.trim()) return
    const next = [...templates]
    if (editing === 'new') next.push(form)
    else if (typeof editing === 'number') next[editing] = form
    commit(next)
    setEditing(null)
  }

  const remove = (i: number) => {
    const next = templates.filter((_, idx) => idx !== i)
    commit(next)
    if (editing === i) setEditing(null)
  }

  const setField = (k: keyof AgentTemplateRecord, v: string) => setForm(f => ({ ...f, [k]: k === 'model' ? normalizeModelInput(v, 'normal') : v }))

  return (
    <section className="bg-bg-secondary rounded-lg border border-border">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Agent Templates</h3>
          <p className="text-xs text-text-tertiary">Custom templates shown in the Recommended section on each project</p>
        </div>
        {editing === null && (
          <button
            onClick={openNew}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer transition-colors"
          >
            + Add Template
          </button>
        )}
      </div>

      <div className="px-5 py-4 flex flex-col gap-3">
        {templates.length === 0 && editing === null && (
          <p className="text-sm text-text-tertiary text-center py-4">
            No custom templates yet. Add one to override or extend the built-in recommended agents.
          </p>
        )}

        {templates.map((t, i) => (
          editing === i ? (
            <TemplateForm key={i} form={form} setField={setField} onSave={save} onCancel={cancel} isEdit />
          ) : (
            <div key={i} className="p-3 rounded-lg border border-border bg-bg-primary flex items-start justify-between gap-4">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="font-medium text-sm text-text-primary">{t.name}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">{t.model}</span>
                {t.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">every {t.schedule}</span>}
                {t.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{t.description}</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => openEdit(i)}
                  className="px-2.5 py-1 text-xs border border-border rounded bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => remove(i)}
                  className="px-2.5 py-1 text-xs border border-status-error/30 rounded text-status-error hover:bg-status-error/10 cursor-pointer transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          )
        ))}

        {editing === 'new' && (
          <TemplateForm form={form} setField={setField} onSave={save} onCancel={cancel} isEdit={false} />
        )}
      </div>
    </section>
  )
}
