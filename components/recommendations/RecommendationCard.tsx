'use client'

import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import type { Recommendation } from '@/lib/client-api'
import { AUTO_APPLICABLE_RECOMMENDATION_TYPES, isAutoRecommendation } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { recommendationBackoffSchedule } from '@/components/recommendations/schedule-backoff'

function typeLabel(type: string): string {
  if (type === 'agent_schedule_backoff') return 'schedule'
  if (type === 'orchestrator_boost') return 'boost'
  if (type === 'orchestrator_agent_health') return 'health'
  if (type === 'agent_unfruitful') return 'unfruitful'
  return type.replace(/_/g, ' ')
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Auto/manual badge. `agent_unfruitful` is auto-*detected* but its remediation
// is entirely the operator's (widen the prompt, throttle, disable) — labelling
// it AUTO implies the orchestrator will fix it, which it won't. So it carries a
// warning-toned MANUAL pill, while the genuinely informational/already-acted
// types (boost, health) keep the green AUTO pill.
function recommendationBadge(type: string): { text: string; tone: 'success' | 'warning' } | null {
  if (type === 'agent_unfruitful') return { text: 'MANUAL', tone: 'warning' }
  if (isAutoRecommendation(type)) return { text: 'AUTO', tone: 'success' }
  return null
}

// The job whose log explains the recommendation. Unfruitful carries it at the
// payload top level; schedule recs nest it under `reasoning`.
function recommendationSourceJobId(payload: Recommendation['payload']): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const top = stringValue(p.sourceJobId)
  if (top) return top
  const reasoning = p.reasoning
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    return stringValue((reasoning as Record<string, unknown>).sourceJobId)
  }
  return null
}

function isUserEditableAgentId(agentId: string | null): boolean {
  return agentId !== null && !agentId.startsWith('system:')
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanLabel(value: unknown): string | null {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return null
}

function payloadBoolean(payload: Recommendation['payload'], key: string): boolean | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

// Health recommendations (orchestrator_agent_health) carry their metrics at
// the top level of the payload rather than under a nested `reasoning` object.
function healthReasoning(payload: Recommendation['payload']): Array<{ label: string; value: string }> {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  const rows: Array<{ label: string; value: string }> = []
  const severity = stringValue(p.severity)
  const concernType = stringValue(p.concernType)
  const runsAnalyzed = numberValue(p.runsAnalyzed)
  const lastRunScore = numberValue(p.lastRunScore)
  const avgRunScore = numberValue(p.avgRunScore)

  if (concernType) rows.push({ label: 'concern', value: concernType })
  if (severity) rows.push({ label: 'severity', value: severity })
  if (runsAnalyzed != null) rows.push({ label: 'runs analyzed', value: String(runsAnalyzed) })
  if (lastRunScore != null) rows.push({ label: 'last score', value: `${lastRunScore}/100` })
  if (avgRunScore != null) rows.push({ label: 'avg score', value: `${Math.round(avgRunScore)}/100` })
  return rows
}

function recommendationReasoning(payload: Recommendation['payload']): Array<{ label: string; value: string }> {
  const raw = payload?.reasoning
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return healthReasoning(payload)
  const reasoning = raw as Record<string, unknown>
  const rows: Array<{ label: string; value: string }> = []
  const summary = stringValue(reasoning.summary)
  const actionableWork = booleanLabel(reasoning.actionableWork)
  const filesChangedCount = numberValue(reasoning.filesChangedCount)
  const currentSchedule = stringValue(reasoning.currentSchedule)
  const recommendedSchedule = stringValue(reasoning.recommendedSchedule)
  const confidence = stringValue(reasoning.confidence)
  const sourceJobId = stringValue(reasoning.sourceJobId)

  if (summary) rows.push({ label: 'summary', value: summary })
  if (actionableWork) rows.push({ label: 'actionable work', value: actionableWork })
  if (filesChangedCount != null) rows.push({ label: 'files changed', value: String(filesChangedCount) })
  if (currentSchedule && recommendedSchedule) rows.push({ label: 'cadence', value: `${currentSchedule} → ${recommendedSchedule}` })
  if (confidence) rows.push({ label: 'confidence', value: confidence })
  if (sourceJobId) rows.push({ label: 'source job', value: sourceJobId })
  return rows
}

interface RecommendationCardProps {
  item: Recommendation
  busy: boolean
  errorMessage: string | null
  onAccept: () => void
  onDismiss: () => void
  // Fires the agent immediately (manual "Run now" Fix action). Optional so the
  // per-project recommendations tab can omit it.
  onRunNow?: () => void
  // Lengthens the agent's schedule to reduce noise. Only rendered when the
  // recommendation payload supports a strictly slower target schedule.
  onBackOff?: (schedule: string) => void
  // Runs the agent with a read-only diagnostic prompt to investigate why it
  // stopped producing changes. Only rendered for user-editable agents.
  onInvestigate?: () => void
  // Stops orchestrator boost fires for the agent while leaving its schedule
  // intact. Only rendered for user-editable agents.
  onStopBoosting?: () => void
  // Disables the agent entirely (no scheduled runs). The most disruptive Fix
  // action; only rendered for user-editable agents.
  onDisable?: () => void
  // When set, renders a small "View in project →" link — used by the global
  // recommendations page so each card stays linked to its source project.
  showProjectLink?: boolean
}

export function RecommendationCard({
  item,
  busy,
  errorMessage,
  onAccept,
  onDismiss,
  onRunNow,
  onBackOff,
  onInvestigate,
  onStopBoosting,
  onDisable,
  showProjectLink,
}: RecommendationCardProps) {
  const acceptable = AUTO_APPLICABLE_RECOMMENDATION_TYPES.has(item.type)
  const actionLabel = item.title.trim() || typeLabel(item.type)
  const reasoningRows = recommendationReasoning(item.payload)
  // Fix actions apply to any recommendation that names an agent the operator
  // can remediate. That includes the `agent_unfruitful` card: the orchestrator
  // deprioritizes it automatically, but the operator still wants one-click ways
  // to act on the advice (widen prompt → Edit, check work → Run, investigate →
  // Run investigation/View logs, reduce noise → Decrease rate, stop the bleeding
  // → Stop boosting/Disable agent). Only `orchestrator_boost` (already acted)
  // and `orchestrator_agent_health` (informational) have nothing to fix.
  const showFixMenu = Boolean(item.agent_id) && (!isAutoRecommendation(item.type) || item.type === 'agent_unfruitful')
  const badge = recommendationBadge(item.type)
  const backoffSchedule = recommendationBackoffSchedule(item)
  const editableAgent = isUserEditableAgentId(item.agent_id)
  const sourceJobId = recommendationSourceJobId(item.payload)
  const logsHref = sourceJobId
    ? `/project/${encodeURIComponent(item.project)}/terminal?job=${encodeURIComponent(sourceJobId)}`
    : null
  const agentEnabled = payloadBoolean(item.payload, 'enabled')
  const agentBoostable = payloadBoolean(item.payload, 'boostable')
  const actionableAgent = editableAgent && agentEnabled !== false
  const showRunNow = Boolean(onRunNow && agentEnabled !== false)
  const showBackOff = Boolean(onBackOff && backoffSchedule && actionableAgent)
  const showInvestigate = Boolean(onInvestigate && actionableAgent)
  const showStopBoosting = Boolean(onStopBoosting && actionableAgent && agentBoostable !== false)
  const showDisable = Boolean(onDisable && actionableAgent)
  const editHref = item.agent_id
    ? `/project/${encodeURIComponent(item.project)}/agents?agent=${encodeURIComponent(item.agent_id)}`
    : null
  return (
    <div className="border-b border-border last:border-b-0 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {badge && (
              <Pill
                tone={badge.tone}
                size="xs"
                className="rounded px-1.5 text-[10px] font-mono"
              >
                {badge.text}
              </Pill>
            )}
            <Pill
              tone="accent"
              size="xs"
              className="rounded px-1.5 text-[10px] font-mono border-accent/25"
            >
              {typeLabel(item.type)}
            </Pill>
            {item.agent_name && <span className="font-mono text-xs text-text-tertiary">agent:{item.agent_name}</span>}
            <span className="font-mono text-xs text-text-tertiary">updated {formatAgo(item.updated_at)}</span>
            {showProjectLink && (
              <Link
                href={`/project/${encodeURIComponent(item.project)}`}
                className={buttonVariants({ variant: 'link', size: 'sm', className: 'font-mono' })}
              >
                {item.project} →
              </Link>
            )}
          </div>
          <div className="mt-2 text-sm font-medium text-text-primary">{item.title}</div>
          <div className="mt-1 text-sm text-text-secondary">{item.detail}</div>
          {Boolean(item.payload?.recommendedSchedule) && (
            <div className="mt-2 text-xs font-mono text-text-tertiary">
              current {String(item.payload?.currentSchedule ?? '-')} / suggested {String(item.payload?.recommendedSchedule)}
            </div>
          )}
          {reasoningRows.length > 0 && (
            <div className="mt-2 rounded border border-border bg-bg-secondary/50 p-2">
              <div className="font-mono text-[10px] uppercase text-text-tertiary">Why</div>
              <dl className="mt-1 grid gap-1 text-xs">
                {reasoningRows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                    <dt className="font-mono text-text-tertiary">{row.label}</dt>
                    <dd className="min-w-0 break-words text-text-secondary">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {errorMessage && (
            <div className="mt-2 text-xs text-status-error">{errorMessage}</div>
          )}
        </div>
        <div className="flex items-start gap-2 shrink-0">
          {showFixMenu && (
            <details className="relative group">
              <summary
                className="list-none cursor-pointer select-none rounded bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:bg-accent/90 [&::-webkit-details-marker]:hidden"
                aria-label={`Fix recommendation: ${actionLabel} (${item.project})`}
              >
                {busy ? 'working…' : 'Fix ▾'}
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-48 overflow-hidden rounded border border-border bg-bg-secondary shadow-lg">
                {acceptable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal"
                    disabled={busy}
                    onClick={onAccept}
                    title="Apply the suggested change automatically"
                  >
                    Apply suggested change
                  </Button>
                )}
                {showRunNow && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal"
                    disabled={busy}
                    onClick={onRunNow}
                    title="Trigger an immediate run of this agent"
                  >
                    Run agent now
                  </Button>
                )}
                {logsHref && (
                  <Link
                    href={logsHref}
                    className={buttonVariants({
                      variant: 'ghost',
                      size: 'sm',
                      className: 'w-full justify-start rounded-none px-3 py-2 font-normal',
                    })}
                    title="Open the log of the run that produced this recommendation"
                  >
                    View logs →
                  </Link>
                )}
                {showInvestigate && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal"
                    disabled={busy}
                    onClick={onInvestigate}
                    title="Run the agent read-only to diagnose why it stopped producing changes"
                  >
                    Run investigation
                  </Button>
                )}
                {showBackOff && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal"
                    disabled={busy}
                    onClick={() => {
                      if (backoffSchedule) onBackOff?.(backoffSchedule)
                    }}
                    title={`Run less often — change the agent's schedule to ${backoffSchedule}`}
                  >
                    Decrease rate
                  </Button>
                )}
                {(showStopBoosting || showDisable) && (
                  <div className="border-t border-border" role="separator" />
                )}
                {showStopBoosting && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal"
                    disabled={busy}
                    onClick={onStopBoosting}
                    title="Keep the agent on its schedule but stop orchestrator boost fires"
                  >
                    Stop boosting
                  </Button>
                )}
                {showDisable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none px-3 py-2 font-normal text-status-error"
                    disabled={busy}
                    onClick={onDisable}
                    title="Disable the agent entirely — it will no longer run on its schedule"
                  >
                    Disable agent
                  </Button>
                )}
                {editHref && (
                  <Link
                    href={editHref}
                    className={buttonVariants({
                      variant: 'ghost',
                      size: 'sm',
                      className: 'w-full justify-start rounded-none px-3 py-2 font-normal',
                    })}
                    title="Open the agent editor to adjust its prompt, schedule, or model"
                  >
                    Edit agent…
                  </Link>
                )}
              </div>
            </details>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded bg-bg-tertiary text-text-secondary hover:text-text-primary"
            disabled={busy}
            onClick={onDismiss}
            aria-label={`Dismiss recommendation: ${actionLabel} (${item.project})`}
          >
            dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}
