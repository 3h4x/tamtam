'use client'

import React, { useRef, useEffect } from 'react'
import Link from 'next/link'
import type { SkillItem, DocItem } from '@/lib/terminal/terminal-session-store'
import { MODEL_TIERS, MODEL_LABELS, MODEL_DESCRIPTIONS, type ModelTier } from '@/lib/agents/model-aliases'

interface TerminalToolbarProps {
  projectName: string
  streaming: boolean
  showSessions: boolean
  sessions: { finishedAt: number | null; exitCode: number | null }[]
  currentReleaseId: string | null
  showThinking: boolean
  selectedItems: SkillItem[]
  selectedDocs: DocItem[]
  allItems: SkillItem[]
  allDocs: DocItem[]
  skillSearch: string
  showSkillPicker: boolean
  skillUsage: Record<string, number>
  docsSearch: string
  showDocsPicker: boolean
  model: ModelTier
  filteredItems: SkillItem[]
  filteredDocs: DocItem[]
  onNewSession: () => void
  onToggleSessions: () => void
  onToggleThinking: () => void
  onToggleItem: (item: SkillItem) => void
  onToggleDoc: (doc: DocItem) => void
  onSkillSearchChange: (v: string) => void
  onToggleSkillPicker: () => void
  onDocsSearchChange: (v: string) => void
  onToggleDocsPicker: () => void
  onModelChange: (m: ModelTier) => void
}

export function TerminalToolbar({
  projectName,
  streaming,
  showSessions,
  sessions,
  currentReleaseId,
  showThinking,
  selectedItems,
  selectedDocs,
  allItems,
  allDocs,
  skillSearch,
  showSkillPicker,
  skillUsage,
  docsSearch,
  showDocsPicker,
  model,
  filteredItems,
  filteredDocs,
  onNewSession,
  onToggleSessions,
  onToggleThinking,
  onToggleItem,
  onToggleDoc,
  onSkillSearchChange,
  onToggleSkillPicker,
  onDocsSearchChange,
  onToggleDocsPicker,
  onModelChange,
}: TerminalToolbarProps) {
  const skillSearchRef = useRef<HTMLInputElement>(null)
  const docsSearchRef = useRef<HTMLInputElement>(null)
  const toolbarButtonClass = 'inline-flex items-center gap-1 rounded-md border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-secondary font-mono leading-none transition-colors hover:text-text-primary cursor-pointer'
  const pickerButtonClass = 'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] leading-none transition-colors cursor-pointer'

  useEffect(() => {
    if (showSkillPicker) skillSearchRef.current?.focus()
  }, [showSkillPicker])

  useEffect(() => {
    if (showDocsPicker) docsSearchRef.current?.focus()
  }, [showDocsPicker])

  const allSelected = [
    ...selectedItems.map(i => ({ label: i.name, remove: () => onToggleItem(i), key: `s:${i.id}` })),
    ...selectedDocs.map(d => ({ label: d.name, remove: () => onToggleDoc(d), key: `d:${d.name}` })),
  ]
  const SHOW = 3
  const visible = allSelected.slice(0, SHOW)
  const overflow = allSelected.length - SHOW
  const hasSelections = allSelected.length > 0

  return (
    <div className="border-b border-border bg-bg-secondary px-3 py-2 shrink-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary font-mono">session</span>
          <div className="flex flex-wrap items-center gap-1.5">
        <button
              className={toolbarButtonClass}
          onClick={onNewSession}
          title="New session"
        >
          new
        </button>
        <button
              className={toolbarButtonClass}
          onClick={onToggleSessions}
          title="Recent sessions"
        >
          {showSessions ? 'close' : 'recent'}
          {!showSessions && sessions.some(s => s.finishedAt === null && s.exitCode === null) && (
            <span className="ml-0.5 text-status-warning text-[10px]">●</span>
          )}
        </button>
        {streaming && (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-warning/15 px-2 py-1 text-[10px] text-status-warning font-mono leading-none">
            <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse" />
            live
          </span>
        )}
        {currentReleaseId && (
          <Link
            href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(currentReleaseId)}`}
            className="inline-flex items-center h-7 px-2 rounded-md border border-border bg-bg-primary text-[11px] text-accent hover:text-accent/80 font-mono leading-none transition-colors"
            title="View unified release trace"
          >
            trace ↗
          </Link>
        )}
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button
              className={`${toolbarButtonClass} ${showThinking ? 'border-accent bg-accent/10 text-accent' : ''}`}
          onClick={onToggleThinking}
          title="Toggle thinking blocks"
        >
          thinking
        </button>
            <div className="inline-flex items-center rounded-md border border-border bg-bg-primary px-1.5 py-1">
              <span className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary font-mono">attach</span>
              <div className="relative">
          <button
                  className={`${pickerButtonClass} ${
                    showSkillPicker ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-transparent text-text-secondary hover:text-text-primary'
            }`}
            onClick={onToggleSkillPicker}
          >
                  skills{selectedItems.length > 0 ? ` ${selectedItems.length}` : ''}
          </button>
          {showSkillPicker && (
            <div className="absolute top-full right-0 mt-1 w-96 bg-bg-secondary border border-border rounded-lg shadow-lg z-50 overflow-hidden">
              <input
                ref={skillSearchRef}
                type="text"
                    className="focus-ring w-full px-3 py-2.5 text-sm bg-bg-primary border-b border-border text-text-primary outline-none placeholder:text-text-tertiary/40 font-mono"
                value={skillSearch}
                onChange={(e) => onSkillSearchChange(e.target.value)}
                placeholder="search skills..."
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { onToggleSkillPicker(); onSkillSearchChange('') }
                  if (e.key === 'Enter' && filteredItems.length > 0) onToggleItem(filteredItems[0])
                }}
              />
              <div className="max-h-80 overflow-y-auto">
                {filteredItems.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-text-tertiary/50">
                    {allItems.length === 0 ? 'no skills' : 'no matches'}
                  </div>
                ) : (
                  filteredItems.slice(0, 50).map(item => {
                    const isSelected = selectedItems.some(s => s.id === item.id)
                    return (
                      <button
                        key={item.id}
                            className={`w-full border-none px-3 py-2 text-left cursor-pointer font-mono transition-colors ${
                          isSelected
                            ? 'bg-accent/10 hover:bg-accent/15 text-accent'
                            : 'hover:bg-bg-tertiary bg-transparent text-text-primary'
                        }`}
                        onClick={() => onToggleItem(item)}
                        title={item.description || item.name}
                      >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex min-w-0 items-start gap-2">
                                <span className="mt-0.5 shrink-0 w-3 text-center text-[10px]">{isSelected ? '✓' : ''}</span>
                                <div className="min-w-0">
                                  <div className="truncate text-xs">{item.name}</div>
                                  {item.description && (
                                    <div className="mt-0.5 truncate text-[10px] text-text-tertiary">
                                      {item.description}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[10px] text-text-tertiary/60">{item.source === 'db' ? 'db' : 'file'}</span>
                                {(skillUsage[item.id] || 0) > 0 && (
                                  <span className="text-[10px] text-text-tertiary/50">{skillUsage[item.id]}</span>
                                )}
                              </div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
        <div className="relative">
          <button
                  className={`${pickerButtonClass} ${
                    showDocsPicker ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-transparent text-text-secondary hover:text-text-primary'
            }`}
            onClick={onToggleDocsPicker}
          >
                  docs{selectedDocs.length > 0 ? ` ${selectedDocs.length}` : ''}
          </button>
          {showDocsPicker && (
            <div className="absolute top-full right-0 mt-1 w-72 bg-bg-secondary border border-border rounded-lg shadow-lg z-50 overflow-hidden">
              <input
                ref={docsSearchRef}
                type="text"
                    className="focus-ring w-full px-3 py-2.5 text-sm bg-bg-primary border-b border-border text-text-primary outline-none placeholder:text-text-tertiary/40 font-mono"
                value={docsSearch}
                onChange={(e) => onDocsSearchChange(e.target.value)}
                placeholder="search docs..."
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { onToggleDocsPicker(); onDocsSearchChange('') }
                  if (e.key === 'Enter' && filteredDocs.length > 0) onToggleDoc(filteredDocs[0])
                }}
              />
              <div className="max-h-80 overflow-y-auto">
                {filteredDocs.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-text-tertiary/50">
                    {allDocs.length === 0 ? 'no docs' : 'no matches'}
                  </div>
                ) : (
                  filteredDocs.map(doc => {
                    const isSelected = selectedDocs.some(d => d.name === doc.name)
                    return (
                      <button
                        key={doc.name}
                            className={`w-full border-none px-3 py-2 text-left text-xs cursor-pointer font-mono transition-colors ${
                          isSelected ? 'bg-accent/10 hover:bg-accent/15 text-accent' : 'hover:bg-bg-tertiary bg-transparent text-text-primary'
                        }`}
                        onClick={() => onToggleDoc(doc)}
                      >
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 w-3 text-center text-[10px]">{isSelected ? '✓' : ''}</span>
                              <span className="truncate">{doc.name}</span>
                            </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
            </div>
            <div className="inline-flex items-center rounded-md border border-border bg-bg-primary px-1.5 py-1">
              <span className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary font-mono">model</span>
          {MODEL_TIERS.map((m) => (
            <button
              key={m}
                  className={`rounded px-1.5 py-0.5 text-[10px] cursor-pointer border-none font-mono leading-none transition-colors ${
                model === m
                  ? 'bg-accent/15 text-accent'
                    : 'bg-transparent text-text-secondary hover:text-text-primary'
              }`}
              onClick={async () => {
                onModelChange(m)
                await fetch('/api/settings', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ default_model: m }),
                }).catch(() => {})
              }}
              title={
                `${MODEL_LABELS[m]} — ${MODEL_DESCRIPTIONS[m]}`
              }
            >
              {MODEL_LABELS[m]}
            </button>
          ))}
            </div>
          </div>

          {hasSelections && (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <span className="px-1 text-[10px] uppercase tracking-wider text-text-tertiary font-mono">selected</span>
              {visible.map(item => (
                <span key={item.key} className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-accent/20 bg-accent/10 px-2 py-1 text-[10px] text-accent font-mono">
                  <span className="truncate">{item.label}</span>
                  <button className="shrink-0 border-none bg-transparent leading-none text-accent/45 hover:text-accent cursor-pointer" onClick={item.remove} title={`Remove ${item.label}`}>×</button>
                </span>
              ))}
              {overflow > 0 && (
                <button
                  className="inline-flex items-center rounded-full border border-border bg-bg-primary px-2 py-1 text-[10px] text-text-tertiary font-mono cursor-pointer hover:bg-accent/10 hover:text-text-primary transition-colors"
                  title={allSelected.slice(SHOW).map(i => i.label).join(', ')}
                  onClick={onToggleSkillPicker}
                >
                  +{overflow}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
