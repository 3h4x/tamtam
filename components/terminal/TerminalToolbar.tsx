'use client'

import React, { useRef, useEffect } from 'react'
import Link from 'next/link'
import type { SkillItem, DocItem } from '@/lib/terminal/terminal-session-store'

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
  model: 'haiku' | 'sonnet' | 'opus'
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
  onModelChange: (m: 'haiku' | 'sonnet' | 'opus') => void
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

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-bg-secondary border-b border-border shrink-0">
      <div className="flex items-center gap-1.5">
        <button
          className="text-[11px] px-2 py-1 h-[26px] rounded bg-bg-tertiary text-text-tertiary hover:text-text-primary cursor-pointer border-none font-mono leading-none"
          onClick={onNewSession}
          title="New session"
        >
          new
        </button>
        <button
          className="text-[11px] px-2 py-1 h-[26px] rounded bg-bg-tertiary text-text-tertiary hover:text-text-primary cursor-pointer border-none font-mono leading-none flex items-center gap-1"
          onClick={onToggleSessions}
          title="Recent sessions"
        >
          {showSessions ? 'close' : 'recent'}
          {!showSessions && sessions.some(s => s.finishedAt === null && s.exitCode === null) && (
            <span className="ml-0.5 text-status-warning text-[10px]">●</span>
          )}
        </button>
        {streaming && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning font-mono leading-none flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse" />
            live
          </span>
        )}
        {currentReleaseId && (
          <Link
            href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(currentReleaseId)}`}
            className="text-[11px] px-2 py-1 h-[26px] rounded bg-bg-tertiary text-accent hover:text-accent/80 font-mono leading-none flex items-center"
            title="View unified release trace"
          >
            trace ↗
          </Link>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          className={`text-[11px] px-2 py-1 h-[26px] rounded cursor-pointer border-none font-mono leading-none ${showThinking ? 'bg-accent/20 text-accent' : 'bg-bg-tertiary text-text-tertiary hover:text-text-primary'}`}
          onClick={onToggleThinking}
          title="Toggle thinking blocks"
        >
          thinking
        </button>
        {visible.map(item => (
          <span key={item.key} className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono gap-0.5 max-w-[100px]">
            <span className="truncate">{item.label}</span>
            <button className="text-accent/40 hover:text-accent cursor-pointer border-none bg-transparent leading-none shrink-0" onClick={item.remove} title={`Remove ${item.label}`}>×</button>
          </span>
        ))}
        {overflow > 0 && (
          <span
            className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent/70 font-mono cursor-pointer hover:bg-accent/20"
            title={allSelected.slice(SHOW).map(i => i.label).join(', ')}
            onClick={onToggleSkillPicker}
          >
            +{overflow} more
          </span>
        )}
        <div className="relative">
          <button
            className="text-[11px] px-2 py-1 h-[26px] rounded bg-bg-tertiary text-text-tertiary hover:text-text-primary cursor-pointer border-none font-mono leading-none"
            onClick={onToggleSkillPicker}
          >
            +skill
          </button>
          {showSkillPicker && (
            <div className="absolute top-full right-0 mt-1 w-96 bg-bg-secondary border border-border rounded-lg shadow-lg z-50 overflow-hidden">
              <input
                ref={skillSearchRef}
                type="text"
                className="w-full px-3 py-2.5 text-sm bg-bg-primary border-b border-border text-text-primary outline-none placeholder:text-text-tertiary/40 font-mono"
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
                        className={`w-full px-3 py-2 text-left text-xs cursor-pointer border-none font-mono flex items-center justify-between gap-2 transition-colors ${
                          isSelected
                            ? 'bg-accent/10 hover:bg-accent/15 text-accent'
                            : 'hover:bg-bg-tertiary bg-transparent text-text-primary'
                        }`}
                        onClick={() => onToggleItem(item)}
                        title={item.description || item.name}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0 w-3 text-center text-[10px]">{isSelected ? '✓' : ''}</span>
                          <span className="truncate">{item.name}</span>
                          <span className="text-text-tertiary/50 shrink-0">{item.source === 'db' ? 'db' : 'file'}</span>
                        </div>
                        {(skillUsage[item.id] || 0) > 0 && (
                          <span className="text-[10px] text-text-tertiary/40 shrink-0">{skillUsage[item.id]}</span>
                        )}
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
            className="text-[11px] px-2 py-1 h-[26px] rounded bg-bg-tertiary text-text-tertiary hover:text-text-primary cursor-pointer border-none font-mono leading-none"
            onClick={onToggleDocsPicker}
          >
            +docs
          </button>
          {showDocsPicker && (
            <div className="absolute top-full right-0 mt-1 w-72 bg-bg-secondary border border-border rounded-lg shadow-lg z-50 overflow-hidden">
              <input
                ref={docsSearchRef}
                type="text"
                className="w-full px-3 py-2.5 text-sm bg-bg-primary border-b border-border text-text-primary outline-none placeholder:text-text-tertiary/40 font-mono"
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
                        className={`w-full px-3 py-2 text-left text-xs cursor-pointer border-none font-mono flex items-center gap-2 transition-colors ${
                          isSelected ? 'bg-accent/10 hover:bg-accent/15 text-accent' : 'hover:bg-bg-tertiary bg-transparent text-text-primary'
                        }`}
                        onClick={() => onToggleDoc(doc)}
                      >
                        <span className="shrink-0 w-3 text-center text-[10px]">{isSelected ? '✓' : ''}</span>
                        <span className="truncate">{doc.name}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center h-[26px] rounded overflow-hidden border border-border">
          {(['haiku', 'sonnet', 'opus'] as const).map((m) => (
            <button
              key={m}
              className={`text-[11px] px-2 h-full cursor-pointer border-none font-mono leading-none transition-colors ${
                model === m
                  ? 'bg-accent/20 text-accent'
                  : 'bg-bg-tertiary text-text-tertiary hover:text-text-primary'
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
                m === 'haiku' ? 'haiku — fastest, lowest cost' :
                m === 'sonnet' ? 'sonnet — balanced speed and quality' :
                'opus — most capable, highest quality'
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
