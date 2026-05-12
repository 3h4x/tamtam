'use client'

import React, { useRef, useEffect } from 'react'
import Link from 'next/link'
import type { SkillItem, DocItem } from '@/lib/terminal/terminal-session-store'
import { MODEL_TIERS, MODEL_LABELS, MODEL_DESCRIPTIONS, type ModelTier } from '@/lib/agents/model-aliases'
import { dispatchSettingsChanged } from '@/lib/shared/settings-events'
import { CLI_PROVIDERS, type CliProvider } from '@/lib/usage/cli-providers'
import { ToolbarDropdown, type ToolbarDropdownOption } from './ToolbarDropdown'

const PROVIDER_LABELS: Record<CliProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  lmstudio: 'LM Studio',
}

const PROVIDER_DESCRIPTIONS: Record<CliProvider, string> = {
  claude: 'Anthropic Claude CLI',
  codex: 'OpenAI Codex CLI',
  gemini: 'Google Gemini CLI',
  lmstudio: 'Local LM Studio',
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-bg-tertiary px-1 text-[10px] leading-none text-text-tertiary tabular-nums">
      {count}
    </span>
  )
}

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
  provider: CliProvider | null
  providerLocked: boolean
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
  onProviderChange: (provider: CliProvider | null) => void
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
  provider,
  providerLocked,
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
  onProviderChange,
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
  const hasSelections = allSelected.length > 0

  return (
    <div className="border-b border-border bg-bg-secondary px-3 py-2 shrink-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">

        {/* Left: SESSION group */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="toolbar-label">session</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button className="toolbar-btn" onClick={onNewSession} title="New session">
              new
            </button>
            <button className="toolbar-btn" onClick={onToggleSessions} title="Recent sessions">
              {showSessions ? 'close' : 'recent'}
              {!showSessions && sessions.some(s => s.finishedAt === null && s.exitCode === null) && (
                <span className="text-status-warning text-[10px]">●</span>
              )}
            </button>
            {streaming && (
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-status-warning/15 px-2 text-[10px] text-status-warning font-mono leading-none">
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse" />
                live
              </span>
            )}
            {currentReleaseId && (
              <Link
                href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(currentReleaseId)}`}
                className="toolbar-btn"
                title="View unified release trace"
              >
                trace ↗
              </Link>
            )}
          </div>
        </div>

        {/* Right: thinking + ATTACH + MODEL + PROVIDER */}
        <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              className={`toolbar-btn${showThinking ? ' active' : ''}`}
              onClick={onToggleThinking}
              title="Toggle thinking blocks"
            >
              thinking
            </button>

            {/* ATTACH group */}
            <div className="toolbar-group">
              <span className="toolbar-label">attach</span>

              {/* Skills picker */}
              <div className="relative">
                <button
                  className={`toolbar-tab${showSkillPicker ? ' active' : ''}`}
                  onClick={onToggleSkillPicker}
                >
                  <span>skills</span>
                  {selectedItems.length > 0 && <CountBadge count={selectedItems.length} />}
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

              {/* Docs picker */}
              <div className="relative">
                <button
                  className={`toolbar-tab${showDocsPicker ? ' active' : ''}`}
                  onClick={onToggleDocsPicker}
                >
                  <span>docs</span>
                  {selectedDocs.length > 0 && <CountBadge count={selectedDocs.length} />}
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

            {/* MODEL dropdown */}
            <ToolbarDropdown<ModelTier>
              label="model"
              value={model}
              options={MODEL_TIERS.map((m): ToolbarDropdownOption<ModelTier> => ({
                value: m,
                label: MODEL_LABELS[m],
                description: MODEL_DESCRIPTIONS[m],
              }))}
              onChange={async (m) => {
                onModelChange(m)
                const response = await fetch('/api/settings', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ default_model: m }),
                }).catch(() => {})
                const payload = response && 'ok' in response && response.ok
                  ? await response.json().catch(() => null)
                  : null
                if (payload?.settings) {
                  dispatchSettingsChanged(payload.settings)
                }
              }}
            />

            {/* PROVIDER dropdown */}
            <ToolbarDropdown<CliProvider | 'any'>
              label="provider"
              value={provider ?? 'any'}
              disabled={providerLocked}
              disabledTitle="This session is locked to its original provider until you start a new session."
              options={[
                { value: 'any', label: 'Any', description: 'Let TamTam choose any healthy enabled provider' },
                ...CLI_PROVIDERS.map((p): ToolbarDropdownOption<CliProvider | 'any'> => ({
                  value: p,
                  label: PROVIDER_LABELS[p],
                  description: PROVIDER_DESCRIPTIONS[p],
                })),
              ]}
              onChange={(v) => onProviderChange(v === 'any' ? null : v)}
            />
          </div>

          {/* Selected pills */}
          {hasSelections && (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <span className="toolbar-label">{allSelected.length} attached</span>
              {visible.map(item => (
                <span key={item.key} className="toolbar-pill">
                  <span className="truncate">{item.label}</span>
                  <button
                    className="shrink-0 border-none bg-transparent leading-none text-accent/45 hover:text-accent cursor-pointer"
                    onClick={item.remove}
                    title={`Remove ${item.label}`}
                  >×</button>
                </span>
              ))}
              {overflow > 0 && (
                <button
                  className="toolbar-btn"
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
