'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { fetchAgentRevisions, fetchProjectDocs, improveAgentPrompt, revertAgent } from '@/lib/client-api'
import type { Agent, AgentRevision, Skill, Persona, ProjectDoc } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { Input } from '@/components/ui/Input'
import { Pill } from '@/components/ui/Pill'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/Toast'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { MODEL_TIERS, MODEL_LABELS, MODEL_DESCRIPTIONS, normalizeModelInput } from '@/lib/agents/model-aliases'
import { ALL_AGENT_ROLES, parseAgentRole } from '@/lib/agents/roles'
import { resolveAgentPrerequisiteCommand, substitutePrerequisiteProjectPlaceholder } from '@/lib/agents/prerequisites'
import { CLI_PROVIDERS, type CliProvider } from '@/lib/usage/cli-providers'
import { AgentScheduleStrip } from '@/components/agents-tab/AgentScheduleStrip'

const MODELS = [...MODEL_TIERS]
// Mirror of VALID_PERMISSION_MODES (lib/shared/config.ts) kept inline so this
// client component doesn't pull server config. '' = inherit the global
// `permission_mode` setting; a non-empty value overrides it for this agent.
const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'default', 'plan'] as const

export interface AgentEditorSavePayload {
  name: string
  prompt: string
  skillIds: string[]
  docPaths: string[]
  model: string
  schedule: string | null
  enabled: boolean
  boostable: boolean
  provider: CliProvider | null
  fallbackEnabled?: boolean
  prerequisiteCommand: string | null
  permissionMode: string | null
  role: string
}

export function AgentEditor({
  agent,
  template,
  project,
  skills,
  personas,
  onSave,
  onDelete,
  onBack,
  onReverted,
  autoImprove,
  onAutoImproveConsumed,
}: {
  agent?: Agent
  template?: AgentTemplateRecord
  project: string
  skills: Skill[]
  personas: Persona[]
  onSave: (data: AgentEditorSavePayload) => Promise<void>
  onDelete?: () => void
  onBack: () => void
  onReverted?: (agent: Agent) => void
  // When true (e.g. arriving from a recommendation's "Improve prompt" action),
  // run the failure-aware improve flow once on mount so the operator lands on a
  // proposed rewrite ready to review and save.
  autoImprove?: boolean
  onAutoImproveConsumed?: () => void
}) {
  const initialSkillIds = agent?.skillIds || template?.skillIds || []
  const initialPrerequisite = agent
    ? (agent.prerequisiteCommand ?? '')
    : (template?.prerequisiteCommand
        ? substitutePrerequisiteProjectPlaceholder(template.prerequisiteCommand, project)
        : resolveAgentPrerequisiteCommand({
        project,
        skillIds: initialSkillIds,
        prerequisiteCommand: null,
      }) ?? '')
  const [name, setName] = useState(agent?.name || template?.name || '')
  const [agentPrompt, setAgentPrompt] = useState(agent?.prompt || template?.prompt || '')
  const [selectedSkills, setSelectedSkills] = useState<string[]>(initialSkillIds)
  const [selectedDocPaths, setSelectedDocPaths] = useState<string[]>(agent?.docPaths || [])
  const [availableDocs, setAvailableDocs] = useState<ProjectDoc[]>([])
  const [contextTab, setContextTab] = useState<'skills' | 'docs'>('skills')
  const [model, setModel] = useState(normalizeModelInput(agent?.model || template?.model, 'normal'))
  const [provider, setProvider] = useState<CliProvider | null>((agent?.provider as CliProvider | null | undefined) ?? null)
  const [fallbackEnabled, setFallbackEnabled] = useState<boolean>(agent?.fallbackEnabled ?? template?.fallbackEnabled ?? false)
  const [schedule, setSchedule] = useState(agent?.schedule || template?.schedule || '')
  const [enabled, setEnabled] = useState<boolean>(agent ? agent.enabled : true)
  const [boostable, setBoostable] = useState<boolean>(agent ? (agent.boostable ?? true) : true)
  const [role, setRole] = useState<string>(parseAgentRole((agent as { role?: string } | null)?.role))
  // Active autopilot override (cadence throttle / model downgrade). The cron
  // resolves these at dispatch in place of the operator's base schedule/model,
  // so surface them here — otherwise the editor shows the base value while the
  // agent actually runs on the override. Auto-restores on recovery.
  const autopilotOverride = useMemo<string | null>(() => {
    const raw = (agent as { autopilotState?: string | null } | null)?.autopilotState
    if (!raw) return null
    let st: { scheduleOverride?: string; modelOverride?: string }
    try { st = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
    const parts: string[] = []
    if (st?.scheduleOverride) parts.push(`cadence → every ${st.scheduleOverride}`)
    if (st?.modelOverride) parts.push(`model → ${st.modelOverride}`)
    return parts.length ? parts.join(' · ') : null
  }, [agent])
  const [prerequisiteCommand, setPrerequisiteCommand] = useState<string>(initialPrerequisite)
  const [permissionMode, setPermissionMode] = useState<string>(agent?.permissionMode ?? '')
  const [saving, setSaving] = useState(false)
  const [improving, setImproving] = useState(false)
  const [mode, setMode] = useState<'edit' | 'history'>('edit')
  const [revisions, setRevisions] = useState<AgentRevision[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [revertingId, setRevertingId] = useState<number | null>(null)
  const autoImproveFiredRef = useRef(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  // System agents are auto-managed: their identity (name, prompt, skills,
  // docs, model, provider) is owned by TamTam. Only the schedule and
  // enabled toggles are user-tunable.
  const isSystemAgent = agent?.kind === 'system'

  // Memoize allItems + the id→item lookup since they only change when
  // skills/personas reload (rare) — the selected-chip render below was
  // doing O(K × M) .find() per render for K selected and M total items.
  const allItems = useMemo(() => [
    ...skills.map(s => ({ id: s.id, name: s.name, description: s.description, source: 'db' as const })),
    ...personas.map(p => ({ id: `persona:${p.path}`, name: `${p.emoji ? p.emoji + ' ' : ''}${p.name}`, description: `${p.category}${p.description ? ' — ' + p.description : ''}`, source: 'file' as const })),
  ], [skills, personas])
  const itemById = useMemo(() => new Map(allItems.map(i => [i.id, i])), [allItems])
  const docByPath = useMemo(() => new Map(availableDocs.map(d => [d.path, d])), [availableDocs])

  const normalizedSkillSearch = skillSearch.toLowerCase()
  const filteredItems = normalizedSkillSearch
    ? allItems.filter(item => {
        return item.name.toLowerCase().includes(normalizedSkillSearch) ||
          item.description.toLowerCase().includes(normalizedSkillSearch) ||
          item.id.toLowerCase().includes(normalizedSkillSearch)
      })
    : allItems

  useEffect(() => {
    fetchProjectDocs(project).then(({ docs }) => setAvailableDocs(docs)).catch(() => {})
  }, [project])

  useEffect(() => {
    const src = agent || template
    if (!src) return
    setName(src.name || '')
    setAgentPrompt(src.prompt || '')
    setSelectedSkills(src.skillIds || [])
    setSelectedDocPaths((agent?.docPaths) || [])
    setModel(normalizeModelInput(src.model, 'normal'))
    setRole(parseAgentRole((src as { role?: string }).role))
    setProvider((agent?.provider as CliProvider | null | undefined) ?? null)
    setFallbackEnabled(agent?.fallbackEnabled ?? template?.fallbackEnabled ?? false)
    setPermissionMode(agent?.permissionMode ?? '')
    setSchedule(src.schedule || '')
    if (agent) setEnabled(agent.enabled)
    setPrerequisiteCommand(agent
      ? (agent.prerequisiteCommand ?? '')
      : (template?.prerequisiteCommand
          ? substitutePrerequisiteProjectPlaceholder(template.prerequisiteCommand, project)
          : resolveAgentPrerequisiteCommand({
          project,
          skillIds: src.skillIds || [],
          prerequisiteCommand: null,
        }) ?? ''))
    setMode('edit')
    setRevisions([])
  }, [agent?.id, project, template?.name, template?.prerequisiteCommand])

  useEffect(() => {
    if (!agent) nameRef.current?.focus()
  }, [])

  const toggleSkill = (skillId: string) => {
    if (isSystemAgent) return
    setSelectedSkills(prev =>
      prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]
    )
  }

  const toggleDoc = (path: string) => {
    if (isSystemAgent) return
    setSelectedDocPaths(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    )
  }

  const handleSave = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ name, prompt: agentPrompt, skillIds: selectedSkills, docPaths: selectedDocPaths, model, schedule: schedule || null, enabled, boostable, provider, fallbackEnabled, prerequisiteCommand: prerequisiteCommand.trim() || null, permissionMode: permissionMode || null, role })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save agent', 'error')
    }
    setSaving(false)
  }

  const handleImprove = async () => {
    const draft = agentPrompt.trim()
    if (isSystemAgent || improving || draft.length < 3) return
    setImproving(true)
    try {
      const result = await improveAgentPrompt({
        project,
        draftPrompt: draft,
        skillIds: selectedSkills,
        docPaths: selectedDocPaths,
        // Existing agent → pass identity so the rewrite sees recent run outcomes.
        ...(agent ? { agentId: agent.id, agentName: name.trim() || agent.name } : {}),
      })
      if (result.improvedPrompt) setAgentPrompt(result.improvedPrompt)
      toast('Prompt improved (Cmd+Z to undo)', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to improve prompt', 'error')
    } finally {
      setImproving(false)
    }
  }

  const loadHistory = async () => {
    if (!agent || historyLoading) return
    setHistoryLoading(true)
    try {
      const result = await fetchAgentRevisions(agent.id)
      setRevisions(result.revisions)
    } finally {
      setHistoryLoading(false)
    }
  }

  const openHistory = () => {
    setMode('history')
    void loadHistory()
  }

  const applyAgentState = (updated: Agent) => {
    setName(updated.name)
    setAgentPrompt(updated.prompt)
    setSelectedSkills(updated.skillIds || [])
    setSelectedDocPaths(updated.docPaths || [])
    setModel(normalizeModelInput(updated.model, 'normal'))
    setRole(parseAgentRole((updated as { role?: string }).role))
    setProvider((updated.provider as CliProvider | null | undefined) ?? null)
    setFallbackEnabled(updated.fallbackEnabled ?? false)
    setPermissionMode(updated.permissionMode ?? '')
    setSchedule(updated.schedule || '')
    setEnabled(updated.enabled)
    setBoostable(updated.boostable ?? true)
    setPrerequisiteCommand(updated.prerequisiteCommand ?? '')
  }

  const handleRevert = async (revisionId: number) => {
    if (!agent || revertingId !== null) return
    setRevertingId(revisionId)
    try {
      const result = await revertAgent(agent.id, revisionId)
      applyAgentState(result.agent)
      onReverted?.(result.agent)
      const history = await fetchAgentRevisions(agent.id)
      setRevisions(history.revisions)
      setMode('edit')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to revert agent', 'error')
    } finally {
      setRevertingId(null)
    }
  }

  // One-shot: when launched with autoImprove (the recommendation "Improve
  // prompt" action), run the failure-aware improve once the existing agent's
  // prompt has loaded. Guarded by a ref so it never re-fires on re-render.
  useEffect(() => {
    if (!autoImprove || autoImproveFiredRef.current) return
    autoImproveFiredRef.current = true
    onAutoImproveConsumed?.()
    if (isSystemAgent || !agent || agentPrompt.trim().length < 3) return
    // Fires at most once per editor mount, gated by autoImproveFiredRef above.
    void handleImprove()
  }, [autoImprove, agent?.id, agentPrompt])

  const isNew = !agent

  return (
    <div className="w-full px-4 py-4 flex flex-col gap-4">
      {/* Header strip */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            type="button"
            onClick={onBack}
            variant="ghost"
            size="sm"
            className="!px-0 !py-0 rounded-none border-none bg-transparent text-sm font-normal text-text-secondary hover:bg-transparent hover:text-text-primary"
          >
            ← Back to agents
          </Button>
          <span className="text-text-tertiary">/</span>
          <h2 className="text-base font-semibold text-text-primary truncate">
            {isNew ? 'New agent' : `Edit — ${agent.name}`}
          </h2>
        </div>
        {agent?.source !== 'file' && !isNew && (
          <SegmentedControl
            ariaLabel="Agent editor mode"
            value={mode}
            size="sm"
            options={[
              { value: 'edit', label: 'Edit' },
              { value: 'history', label: 'History' },
            ]}
            onChange={(nextMode) => {
              if (nextMode === 'history') {
                openHistory()
                return
              }
              setMode(nextMode)
            }}
          />
        )}
      </div>

      {isSystemAgent && (
        <div className="px-3 py-2 text-xs rounded-md border border-accent/30 bg-accent/10 text-text-secondary">
          <span className="font-semibold text-accent">Built-in system agent.</span>{' '}
          Identity, behavior, and schedule are managed by TamTam. You can
          disable it here; the schedule is set globally from Settings →
          Retrieval. Deleting removes it for this project until you re-enable
          in Settings.
        </div>
      )}

      {mode === 'history' && agent && (
        <div className="flex flex-col gap-3">
          {historyLoading ? (
            <InlineLoading label="Loading history…" />
          ) : revisions.length === 0 ? (
            <div className="text-sm text-text-secondary">No revisions recorded yet.</div>
          ) : revisions.map((revision) => {
            const snap = revision.parsedSnapshot
            return (
              <div key={revision.id} className="rounded-md border border-border bg-bg-secondary p-3">
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
                  <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div>
                      <div className="mb-1 text-xs font-semibold text-text-tertiary uppercase">Then</div>
                      <pre className="max-h-72 overflow-auto rounded-md bg-bg-primary p-2 text-xs text-text-secondary whitespace-pre-wrap">{snap.prompt}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold text-text-tertiary uppercase">Now</div>
                      <pre className="max-h-72 overflow-auto rounded-md bg-bg-primary p-2 text-xs text-text-secondary whitespace-pre-wrap">{agentPrompt}</pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {mode === 'edit' && <>
      {/* Main 2-column layout: settings (left) + prompt (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Left column — identity + run settings */}
        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor="agent-name" className="block mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Name</label>
            <Input
              ref={nameRef}
              id="agent-name"
              type="text"
              fontFamily="sans"
              className="placeholder:text-text-tertiary disabled:opacity-60 disabled:cursor-not-allowed"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) handleSave() }}
              placeholder="e.g. security-guard"
              disabled={isSystemAgent}
              title={isSystemAgent ? 'Built-in agent name is fixed' : undefined}
            />
          </div>

          {autopilotOverride && (
            <div className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
              ⚙ Autopilot is currently overriding this agent: {autopilotOverride}. The
              base values below stay as configured; the override auto-restores when the
              agent recovers.
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Model</div>
            <SegmentedControl
              ariaLabel="Model tier"
              value={model}
              onChange={(m) => setModel(m)}
              disabled={isSystemAgent}
              options={MODELS.map((m) => ({
                value: m,
                label: MODEL_LABELS[m],
                title: isSystemAgent ? 'Built-in agent model is fixed' : MODEL_DESCRIPTIONS[m],
              }))}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Role</div>
            <SegmentedControl
              ariaLabel="Agent role"
              value={role}
              onChange={(r) => setRole(r)}
              disabled={isSystemAgent}
              options={ALL_AGENT_ROLES.map((r) => ({
                value: r,
                label: r,
                title:
                  r === 'producer'
                    ? 'Judged by code changes; cadence-throttled by autopilot when it churns (loop/noise).'
                    : r === 'monitor'
                      ? 'Watchdog; value = coverage. Cadence never throttled; model downgraded when idle.'
                      : r === 'reviewer'
                        ? 'Reviews/QA; value = verdicts. Cadence never throttled; model downgraded when idle.'
                        : r === 'planner'
                          ? 'Plans/research; value = artifacts. Cadence never throttled; model downgraded when idle.'
                          : 'Published output (blog/social); never auto-managed.',
              }))}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Provider</div>
            <SegmentedControl<'any' | CliProvider>
              ariaLabel="CLI provider"
              value={provider === null ? 'any' : provider}
              onChange={(v) => setProvider(v === 'any' ? null : v)}
              disabled={isSystemAgent}
              options={[
                {
                  value: 'any',
                  label: 'any',
                  title: isSystemAgent
                    ? 'Built-in agent provider is fixed'
                    : 'Let TamTam choose any healthy enabled provider at run time',
                },
                ...CLI_PROVIDERS.map((cliProvider) => ({
                  value: cliProvider,
                  label: cliProvider,
                  title: isSystemAgent
                    ? 'Built-in agent provider is fixed'
                    : `Require ${cliProvider} for this agent. If it is unavailable or over budget, the run will not start.`,
                })),
              ]}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">Permission mode</div>
            <Select
              aria-label="Permission mode"
              surface="secondary"
              focusRing="strong"
              className="disabled:opacity-60 disabled:cursor-not-allowed"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              disabled={isSystemAgent}
              title={isSystemAgent ? 'Built-in agent permission mode is fixed' : "Overrides the global permission mode for this agent's runs."}
            >
              <option value="">Default (global setting)</option>
              {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <p className="text-xs text-text-tertiary mt-1">Leave on Default to inherit Settings → CLI. Override to run this agent with a specific mode (e.g. <span className="font-mono">bypassPermissions</span>).</p>
          </div>

          {/* Schedule / Enabled / Boostable strip */}
          <AgentScheduleStrip
            schedule={schedule}
            setSchedule={setSchedule}
            enabled={enabled}
            setEnabled={setEnabled}
            boostable={boostable}
            setBoostable={setBoostable}
            isSystemAgent={isSystemAgent}
          />
        </div>

        {/* Right column — prompt */}
        <div className="flex flex-col">
          <div className="flex items-baseline justify-between mb-1.5 gap-2">
            <label htmlFor="agent-prompt" className="flex items-baseline gap-2">
              <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Prompt</span>
              {selectedSkills.length > 0 && (
                <span className="text-xs text-text-tertiary font-normal normal-case">optional — skills define default behavior</span>
              )}
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleImprove}
              disabled={isSystemAgent || improving || agentPrompt.trim().length < 3}
              title={isSystemAgent ? 'Built-in agent prompt is fixed' : 'Rewrite this prompt using project context (CLAUDE.md + selected skills/docs)'}
              className="rounded-md text-text-secondary hover:text-accent hover:border-accent/40"
            >
              {improving ? <Spinner color="accent" /> : null}
              <span>{improving ? 'Improving…' : 'Improve'}</span>
            </Button>
          </div>
          <Textarea
            id="agent-prompt"
            appearance="elevated"
            className="min-h-[420px]"
            rows={20}
            value={agentPrompt}
            onChange={(e) => setAgentPrompt(e.target.value)}
            placeholder={selectedSkills.length > 0
              ? 'Optional: repo-specific hints to append to the skill (e.g. "focus on lib/auth").'
              : 'What should this agent do when it runs?'}
            disabled={isSystemAgent}
            title={isSystemAgent ? 'Built-in agent prompt is fixed' : undefined}
          />
        </div>
      </div>

      {/* Prerequisite command — full width, multi-line */}
      <div>
        <label htmlFor="agent-prerequisite" className="flex items-baseline gap-2 mb-1.5 flex-wrap">
          <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Prerequisite Command</span>
          <span className="text-xs text-text-tertiary font-normal normal-case">optional — runs before the agent; output injected into the prompt</span>
        </label>
        <Textarea
          id="agent-prerequisite"
          appearance="elevated"
          rows={4}
          value={prerequisiteCommand}
          onChange={(e) => setPrerequisiteCommand(e.target.value)}
          placeholder="e.g. pnpm test"
          disabled={isSystemAgent}
          title={isSystemAgent ? 'Built-in agent prerequisite is fixed' : undefined}
          spellCheck={false}
        />
      </div>

      {/* Context: Skills + Docs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Context</span>
          <SegmentedControl
            ariaLabel="Agent context source"
            value={contextTab}
            onChange={setContextTab}
            options={[
              {
                value: 'skills',
                label: (
                  <>
                    Skills{selectedSkills.length > 0 && <span className="ml-1.5 font-bold">{selectedSkills.length}</span>}
                  </>
                ),
              },
              {
                value: 'docs',
                label: (
                  <>
                    Docs{selectedDocPaths.length > 0 && <span className="ml-1.5 font-bold">{selectedDocPaths.length}</span>}
                  </>
                ),
              },
            ]}
          />
        </div>

        {(selectedSkills.length > 0 || selectedDocPaths.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {selectedSkills.map(id => {
              const item = itemById.get(id)
              return (
                <Pill key={id} tone="accent" size="xs" className="gap-1 rounded-full border-accent/25 bg-accent/15 pl-2 pr-1 py-0.5">
                  {item?.name || id}
                  {!isSystemAgent && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="!h-4 !w-4 !rounded-full border-transparent bg-transparent !p-0 !text-current opacity-60 hover:bg-accent/20 hover:!text-current hover:opacity-100"
                      onClick={() => toggleSkill(id)}
                    >
                      ×
                    </Button>
                  )}
                </Pill>
              )
            })}
            {selectedDocPaths.map(path => {
              const doc = docByPath.get(path)
              return (
                <Pill key={path} tone="success" size="xs" className="gap-1 rounded-full bg-status-success/10 pl-2 pr-1 py-0.5">
                  {doc?.name || path}
                  {!isSystemAgent && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="!h-4 !w-4 !rounded-full border-transparent bg-transparent !p-0 !text-current opacity-60 hover:bg-status-success/20 hover:!text-current hover:opacity-100"
                      onClick={() => toggleDoc(path)}
                    >
                      ×
                    </Button>
                  )}
                </Pill>
              )
            })}
          </div>
        )}

        {contextTab === 'skills' && (
          <div className="flex flex-col gap-1.5">
            <Input
              type="text"
              fontFamily="sans"
              className="placeholder:text-text-tertiary disabled:opacity-60 disabled:cursor-not-allowed"
              value={skillSearch}
              onChange={(e) => setSkillSearch(e.target.value)}
              placeholder="Search skills and personas..."
              disabled={isSystemAgent}
            />
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {filteredItems.length === 0 ? (
                <EmptyState paddingY="xs" title="No matches" />
              ) : (
                filteredItems.slice(0, 60).map(item => {
                  const isSelected = selectedSkills.includes(item.id)
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant="ghost"
                      className={`w-full !justify-start !gap-3 !rounded-none !border-0 !px-3 !py-2 text-left !font-normal disabled:!opacity-70 ${
                        isSelected ? '!bg-accent/8 !text-text-primary hover:!bg-accent/8 hover:!text-text-primary' : '!bg-transparent !text-text-primary hover:!bg-bg-secondary hover:!text-text-primary'
                      }`}
                      onClick={() => toggleSkill(item.id)}
                      disabled={isSystemAgent}
                    >
                      <div className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                        isSelected ? 'bg-accent border-accent' : 'border-border'
                      }`}>
                        {isSelected && (
                          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1.5 4.5l2 2 4-4" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{item.name}</span>
                          <span className={`text-[10px] px-1 py-px rounded font-medium ${item.source === 'db' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary'}`}>
                            {item.source === 'db' ? 'custom' : 'file'}
                          </span>
                        </div>
                        {item.description && (
                          <div className="text-xs text-text-tertiary truncate mt-0.5">{item.description}</div>
                        )}
                      </div>
                    </Button>
                  )
                })
              )}
            </div>
          </div>
        )}

        {contextTab === 'docs' && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {availableDocs.length === 0 ? (
              <EmptyState paddingY="xs" title="No docs found for this project" />
            ) : (
              availableDocs.map(doc => {
                const isSelected = selectedDocPaths.includes(doc.path)
                return (
                  <Button
                    key={doc.path}
                    type="button"
                    variant="ghost"
                    className={`w-full !justify-start !gap-3 !rounded-none !border-0 !px-3 !py-2 text-left !font-normal disabled:!opacity-70 ${
                      isSelected ? '!bg-status-success/8 !text-text-primary hover:!bg-status-success/8 hover:!text-text-primary' : '!bg-transparent !text-text-primary hover:!bg-bg-secondary hover:!text-text-primary'
                    }`}
                    onClick={() => toggleDoc(doc.path)}
                    disabled={isSystemAgent}
                  >
                    <div className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                      isSelected ? 'bg-status-success border-status-success' : 'border-border'
                    }`}>
                      {isSelected && (
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1.5 4.5l2 2 4-4" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{doc.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{doc.path}</div>
                    </div>
                  </Button>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 -mx-2 px-2 py-3 border-t border-border bg-bg-primary/95 backdrop-blur flex items-center justify-between">
        <div>
          {onDelete && !confirmDelete && (
            <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          {onDelete && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-status-error">Delete this agent?</span>
              <Button
                type="button"
                variant="danger-solid"
                onClick={() => { onDelete(); onBack() }}
              >
                Delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="solid"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving && <Spinner color="white" shrink />}
            {saving ? 'Saving…' : isNew ? 'Create agent' : 'Save changes'}
          </Button>
        </div>
      </div>
      </>}
    </div>
  )
}
