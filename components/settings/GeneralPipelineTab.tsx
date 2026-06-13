'use client'

import { useState } from 'react'
import { errMsg } from '@/lib/shared/types'
import { FIELDS, GRID_COLS, SUBSECTIONS } from '@/components/settings/constants'
import type { SettingsFieldKey } from '@/components/settings/constants'
import { SettingsField } from '@/components/settings/SettingsField'
import { TrustedGithubUsersField } from '@/components/settings/TrustedGithubUsersField'
import { TAB_LAYOUT } from '@/components/settings/settings-page-config'
import type { SettingsMap, TabId } from '@/components/settings/settings-page-config'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'

export function GeneralPipelineTab({
  activeTab,
  settings,
  handleChange,
  showAdvanced,
  setShowAdvanced,
  setTrustedGithubUsersError,
}: {
  activeTab: TabId
  settings: SettingsMap
  handleChange: (key: keyof SettingsMap, value: string) => void
  showAdvanced: boolean
  setShowAdvanced: (value: boolean) => void
  setTrustedGithubUsersError: (value: string | null) => void
}) {
  const [boardResyncing, setBoardResyncing] = useState(false)
  const [boardResyncMsg, setBoardResyncMsg] = useState<string | null>(null)

  const layout = TAB_LAYOUT[activeTab]
  if (!layout) return null

  // Build a per-subsection field list from FIELDS by subsection id.
  // Provider-conditional fields (lmstudio_model / default_model) are
  // not in general/pipeline subsections today, so no filtering needed —
  // CliTab handles them.
  const fieldsBySubsection = new Map<string, SettingsFieldKey[]>()
  for (const key of Object.keys(FIELDS) as SettingsFieldKey[]) {
    const sub = FIELDS[key].subsection
    if (!sub) continue
    const arr = fieldsBySubsection.get(sub) ?? []
    arr.push(key)
    fieldsBySubsection.set(sub, arr)
  }

  // Tab-level Advanced toggle: surfaces fields with `advanced: true` and
  // subsections whose entire card is gated on advanced (e.g. legacy).
  const tabHasAdvanced = layout.some((e) => {
    if (e.kind !== 'subsection') return false
    const sub = SUBSECTIONS[e.id]
    if (sub?.advanced) return true
    const fields = fieldsBySubsection.get(e.id) ?? []
    return fields.some((k) => FIELDS[k].advanced)
  })

  function renderSubsection(subId: string) {
    const sub = SUBSECTIONS[subId]
    if (!sub) return null
    if (sub.advanced && !showAdvanced) return null
    const fields = (fieldsBySubsection.get(subId) ?? [])
      .filter((k) => !FIELDS[k].advanced || showAdvanced)
    if (fields.length === 0) return null
    const cols = sub.cols ?? 2
    const gridClass = GRID_COLS[cols] ?? 'grid-cols-2'
    const body = (
      <div className={`grid ${gridClass} gap-x-6 gap-y-4`}>
        {fields.map((key) => (
          <SettingsField key={key} fieldKey={key} value={settings[key]} provider={settings.claude_provider} onChange={handleChange} />
        ))}
      </div>
    )
    const header = (
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{sub.title}</h3>
        {sub.description && <p className="text-xs text-text-tertiary">{sub.description}</p>}
      </div>
    )
    return (
      <section key={`sub:${subId}`} className="bg-bg-secondary rounded-lg border border-border">
        {sub.defaultCollapsed ? (
          <details>
            <summary className="px-5 py-3 border-b border-border cursor-pointer list-none flex items-baseline gap-3 group">
              <svg className="w-3 h-3 transition-transform group-open:rotate-90 text-text-tertiary"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {header}
            </summary>
            <div className="px-5 py-4">{body}</div>
          </details>
        ) : (
          <>
            <div className="px-5 py-3 border-b border-border">{header}</div>
            <div className="px-5 py-4">{body}</div>
          </>
        )}
      </section>
    )
  }

  function renderTrustedUsers() {
    return (
      <section key="inline:trusted" className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Trusted GitHub Users</h3>
          <p className="text-xs text-text-tertiary">Workspace allowlist for issue/PR authors whose GitHub content TamTam treats as trusted.</p>
        </div>
        <div className="px-5 py-4">
          <TrustedGithubUsersField
            value={settings.trusted_github_users}
            onChange={(value) => handleChange('trusted_github_users', value)}
            onValidityChange={setTrustedGithubUsersError}
          />
        </div>
      </section>
    )
  }

  function renderRetrieval() {
    return (
      <section key="inline:retrieval" className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h3 className="text-sm font-semibold text-text-primary shrink-0">Retrieval (Embeddings)</h3>
            <p className="text-xs text-text-tertiary truncate">Indexes project docs, skills, and config into pgvector via Ollama; injects top-matching chunks into agent prompts.</p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-text-primary shrink-0">
            <Checkbox
              checked={settings.retrieval_enabled === 'true'}
              onChange={(e) => handleChange('retrieval_enabled', e.target.checked ? 'true' : 'false')}
            />
            Enabled
          </label>
        </div>
        <div className="px-5 py-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Ollama URL</label>
              <Input
                value={settings.retrieval_ollama_url}
                onChange={(e) => handleChange('retrieval_ollama_url', e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Embedding Model</label>
              <Input
                value={settings.retrieval_embedding_model}
                onChange={(e) => handleChange('retrieval_embedding_model', e.target.value)}
                placeholder="nomic-embed-text"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Context Limit</label>
              <Input
                type="number"
                min={1}
                value={settings.retrieval_context_limit}
                onChange={(e) => handleChange('retrieval_context_limit', e.target.value)}
              />
              <p className="mt-1 text-xs text-text-tertiary">Top-K chunks per prompt.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Score Threshold</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.retrieval_score_threshold}
                onChange={(e) => handleChange('retrieval_score_threshold', e.target.value)}
              />
              <p className="mt-1 text-xs text-text-tertiary">0–1 cosine cutoff.</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-6 flex-wrap">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Reindex Interval (hours)</label>
              <Input
                type="number"
                min={1}
                max={168}
                step={1}
                value={settings.retrieval_reindex_interval_hours}
                onChange={(e) => handleChange('retrieval_reindex_interval_hours', e.target.value)}
                fullWidth={false}
                className="w-32"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-text-primary">
              <Checkbox
                checked={settings.retrieval_manage_ollama === 'true'}
                onChange={(e) => handleChange('retrieval_manage_ollama', e.target.checked ? 'true' : 'false')}
              />
              Auto-start Ollama if not running
            </label>
          </div>
        </div>
      </section>
    )
  }

  function renderGithubBoard() {
    return (
      <section key="inline:github_board" className="bg-bg-secondary rounded-lg border border-border">
        <details>
          <summary className="px-5 py-3 border-b border-border cursor-pointer list-none flex items-center justify-between gap-4 group">
            <div className="flex items-baseline gap-3 min-w-0">
              <svg className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90 text-text-tertiary"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <h3 className="text-sm font-semibold text-text-primary">GitHub Board Sync</h3>
              <p className="text-xs text-text-tertiary truncate">
                Mirrors run lifecycle to a global GitHub Project named <code className="font-mono">TamTam</code>.
              </p>
            </div>
            <label
              className="inline-flex items-center gap-2 text-sm text-text-primary shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={settings.github_board_sync_enabled === 'true'}
                onChange={(e) => handleChange('github_board_sync_enabled', e.target.checked ? 'true' : 'false')}
              />
              Enabled
            </label>
          </summary>
          <div className="px-5 py-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Project Owner</label>
                <Input
                  value={settings.github_board_project_owner}
                  onChange={(e) => handleChange('github_board_project_owner', e.target.value)}
                  placeholder={settings.github_owner || 'octocat'}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Project Title</label>
                <Input
                  value={settings.github_board_project_title}
                  onChange={(e) => handleChange('github_board_project_title', e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">Project Number</label>
                <Input
                  value={settings.github_board_project_number}
                  readOnly
                  appearance="muted"
                />
              </div>
            </div>
            {settings.github_board_project_url && (
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <a
                  href={settings.github_board_view_url || settings.github_board_project_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({
                    variant: 'link',
                    size: 'sm',
                    className: 'inline-flex items-center gap-1',
                  })}
                >
                  Open board on GitHub ↗
                </a>
                {settings.github_board_view_url && (
                  <span className="text-xs text-text-tertiary">(custom view configured)</span>
                )}
                <Button
                  type="button"
                  disabled={boardResyncing || settings.github_board_sync_enabled !== 'true'}
                  onClick={async () => {
                    setBoardResyncing(true)
                    setBoardResyncMsg(null)
                    try {
                      const res = await fetch('/api/settings/board-resync', { method: 'POST' })
                      const data = await res.json()
                      if (!res.ok || !data.ok) {
                        setBoardResyncMsg(data.error || `HTTP ${res.status}`)
                      } else {
                        const rl = data.rateLimited ? ', rate-limited — wait 5 min and retry' : ''
                        setBoardResyncMsg(`Resynced ${data.resynced}/${data.scanned} (last ${data.days}d, top ${data.limit}, ${data.failed} failed${rl})`)
                      }
                    } catch (e: unknown) {
                      setBoardResyncMsg(`Failed: ${errMsg(e)}`)
                    } finally {
                      setBoardResyncing(false)
                    }
                  }}
                  size="sm"
                  variant="ghost"
                  className="border-border"
                >
                  {boardResyncing ? 'Resyncing…' : 'Resync recent runs'}
                </Button>
                {boardResyncMsg && <span className="text-xs text-text-tertiary">{boardResyncMsg}</span>}
              </div>
            )}
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-text-secondary">Kanban view URL <span className="text-text-tertiary">(optional)</span></label>
              <Input
                value={settings.github_board_view_url}
                onChange={(e) => handleChange('github_board_view_url', e.target.value)}
                placeholder="https://github.com/users/.../projects/7/views/2"
              />
            </div>
          </div>
        </details>
      </section>
    )
  }

  return (
    <>
      {tabHasAdvanced && (
        <div className="flex justify-end">
          <label className="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer">
            <Checkbox
              size="sm"
              checked={showAdvanced}
              onChange={(e) => setShowAdvanced(e.target.checked)}
              className="cursor-pointer"
            />
            Show advanced
          </label>
        </div>
      )}
      {layout.map((entry) => {
        if (entry.kind === 'subsection') return renderSubsection(entry.id)
        if (entry.id === 'trusted') return renderTrustedUsers()
        if (entry.id === 'retrieval') return renderRetrieval()
        if (entry.id === 'github_board') return renderGithubBoard()
        return null
      })}
    </>
  )
}
