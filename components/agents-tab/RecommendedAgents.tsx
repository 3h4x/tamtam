'use client'

import { useState } from 'react'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { Button, type ButtonVariant } from '@/components/ui/Button'
import { getModelLabel, MODEL_LABELS } from '@/lib/agents/model-aliases'
import { recommendedAgentNameKey, recommendedAgentNameKeys } from '@/lib/agents/recommended-agents'

interface RecommendedAgent extends AgentTemplateRecord {
  aliases?: string[]
  skillIds?: string[]
  essential?: boolean
  featured?: boolean
}

interface RecommendedAgentsProps {
  agents: { name: string }[]
  customTemplates: AgentTemplateRecord[]
  recommendedAgents: RecommendedAgent[]
  onAddAgent: (rec: AgentTemplateRecord) => void
}

type SuggestionTone = 'essential' | 'featured' | 'recommended'

interface SuggestionStyle {
  badgeLabel: string
  badgeClassName: string
  cardClassName: string
  nameClassName: string
  buttonVariant: ButtonVariant
}

type SuggestionLayout = 'full' | 'compact'

const metadataBadgeClassName =
  'rounded-full border border-border bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] tabular-nums text-text-secondary'
const customBadgeClassName =
  'rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-accent'
const sectionCountClassName =
  'rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-mono tabular-nums text-text-tertiary'

const suggestionPriority: Record<SuggestionTone, number> = {
  essential: 0,
  featured: 1,
  recommended: 2,
}

const RECOMMENDED_VISIBLE_LIMIT = 4
const COLLAPSED_NAME_PREVIEW_LIMIT = 3

function formatScheduleLabel(schedule: string | undefined): string | null {
  return schedule ? `every ${schedule}` : null
}

function formatModelBadgeLabel(model: string | null | undefined): string | null {
  const label = getModelLabel(model)
  if (!label || label === MODEL_LABELS.normal) return null
  return label
}

function formatTemplateCount(count: number): string {
  return count === 1 ? '1 template' : `${count} templates`
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function formatVisibleTemplateSummary(visibleCount: number, totalCount: number): string {
  const hiddenCount = Math.max(0, totalCount - visibleCount)
  if (hiddenCount === 0) return `${totalCount} shown`
  if (visibleCount === 0) return `${hiddenCount} hidden`
  return `${visibleCount} shown • ${hiddenCount} hidden`
}

function buildPanelSummary(
  priorityCount: number,
  visibleRecommendedCount: number,
  totalRecommendedCount: number,
): string {
  const hiddenRecommendedCount = Math.max(0, totalRecommendedCount - visibleRecommendedCount)

  if (priorityCount > 0) {
    const optionalSummary: string[] = []

    if (visibleRecommendedCount > 0) {
      optionalSummary.push(`${formatCountLabel(visibleRecommendedCount, 'optional template')} visible`)
    }

    if (hiddenRecommendedCount > 0) {
      optionalSummary.push(`${formatCountLabel(hiddenRecommendedCount, 'optional template')} hidden until expanded`)
    }

    return optionalSummary.length > 0
      ? `Priority first. ${optionalSummary.join(', ')}.`
      : 'Priority first.'
  }

  if (visibleRecommendedCount >= totalRecommendedCount) {
    return `Showing all ${formatCountLabel(totalRecommendedCount, 'suggested template')}.`
  }

  return `Showing ${visibleRecommendedCount} of ${formatCountLabel(totalRecommendedCount, 'suggested template')}.`
}

function formatSkillCount(skillIds: string[] | undefined): string | null {
  if (!skillIds?.length) return null
  return skillIds.length === 1 ? '1 skill' : `${skillIds.length} skills`
}

function formatAliasesLabel(aliases: string[] | undefined): string | null {
  if (!aliases?.length) return null
  return `legacy: ${aliases.join(', ')}`
}

function buildMetadataLabels(rec: RecommendedAgent): string[] {
  const modelLabel = formatModelBadgeLabel(rec.model)
  const scheduleLabel = formatScheduleLabel(rec.schedule)
  const skillCountLabel = formatSkillCount(rec.skillIds)
  const aliasesLabel = formatAliasesLabel(rec.aliases)

  return [
    modelLabel,
    skillCountLabel,
    scheduleLabel,
    aliasesLabel,
  ].filter((label): label is string => Boolean(label))
}

function getSuggestionTone(rec: RecommendedAgent): SuggestionTone {
  if (rec.essential) return 'essential'
  if (rec.featured) return 'featured'
  return 'recommended'
}

function getSuggestionStyle(tone: SuggestionTone): SuggestionStyle {
  if (tone === 'essential') {
    return {
      badgeLabel: 'essential',
      badgeClassName: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
      cardClassName: 'border-status-warning/35 bg-status-warning/5',
      nameClassName: 'text-status-warning',
      buttonVariant: 'warning',
    }
  }

  if (tone === 'featured') {
    return {
      badgeLabel: 'featured',
      badgeClassName: 'border-accent/25 bg-accent/10 text-accent',
      cardClassName: 'border-accent/30 bg-accent/5',
      nameClassName: 'text-accent',
      buttonVariant: 'primary',
    }
  }

  return {
    badgeLabel: 'recommended',
    badgeClassName: 'border-border bg-bg-tertiary text-text-tertiary',
    cardClassName: 'border-border border-dashed bg-bg-secondary/50',
    nameClassName: 'text-text-secondary',
    buttonVariant: 'secondary',
  }
}

function RecommendationNamePreview({
  items,
  remainder,
}: {
  items: RecommendedAgent[]
  remainder: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map(rec => (
        <span
          key={rec.name}
          className="rounded-full border border-border bg-bg-tertiary/60 px-2 py-0.5 text-[10px] font-mono text-text-secondary"
        >
          {rec.name}
        </span>
      ))}
      {remainder > 0 && (
        <span className="text-[11px] text-text-tertiary">
          +{remainder} more
        </span>
      )}
    </div>
  )
}

export function RecommendedAgents({ agents, customTemplates, recommendedAgents, onAddAgent }: RecommendedAgentsProps) {
  const [showExpandedRecommended, setShowExpandedRecommended] = useState(false)
  const existingNames = new Set(agents.map(a => recommendedAgentNameKey(a.name)))
  const customNames = new Set(customTemplates.map(t => recommendedAgentNameKey(t.name)))
  const merged: RecommendedAgent[] = [
    ...customTemplates,
    ...recommendedAgents.filter(r => !recommendedAgentNameKeys(r).some(name => customNames.has(name))),
  ]
  const suggestions = merged
    .filter(r => !recommendedAgentNameKeys(r).some(name => existingNames.has(name)))
    .sort((a, b) => {
      const toneDiff = suggestionPriority[getSuggestionTone(a)] - suggestionPriority[getSuggestionTone(b)]
      if (toneDiff !== 0) return toneDiff

      const customDiff = Number(customNames.has(recommendedAgentNameKey(b.name))) - Number(customNames.has(recommendedAgentNameKey(a.name)))
      if (customDiff !== 0) return customDiff

      return a.name.localeCompare(b.name)
    })
  if (suggestions.length === 0) return null

  // Single-pass partition: was two opposite-predicate filters, each computing
  // getSuggestionTone(rec) again per item. One walk + per-item tone evaluation.
  const prioritySuggestions: RecommendedAgent[] = []
  const recommendedSuggestions: RecommendedAgent[] = []
  for (const rec of suggestions) {
    (getSuggestionTone(rec) === 'recommended' ? recommendedSuggestions : prioritySuggestions).push(rec)
  }
  const customRecommendedSuggestions = recommendedSuggestions.filter(rec => customNames.has(recommendedAgentNameKey(rec.name)))
  const collapseRecommendedByDefault = prioritySuggestions.length > 0
  const recommendedPreviewLimit = collapseRecommendedByDefault ? 0 : RECOMMENDED_VISIBLE_LIMIT
  const defaultVisibleRecommendedSuggestions = collapseRecommendedByDefault
    ? customRecommendedSuggestions
    : recommendedSuggestions.slice(0, recommendedPreviewLimit)
  const visibleRecommendedSuggestions = showExpandedRecommended
    ? recommendedSuggestions
    : defaultVisibleRecommendedSuggestions
  const visibleRecommendedNameKeys = new Set(
    visibleRecommendedSuggestions.map(rec => recommendedAgentNameKey(rec.name)),
  )
  const hiddenRecommendedSuggestions = recommendedSuggestions.filter(
    rec => !visibleRecommendedNameKeys.has(recommendedAgentNameKey(rec.name)),
  )
  const hiddenRecommendedCount = Math.max(0, recommendedSuggestions.length - visibleRecommendedSuggestions.length)
  const showHiddenRecommendedPreview = hiddenRecommendedCount > 0
  const collapsedRecommendedPreview = hiddenRecommendedSuggestions.slice(0, COLLAPSED_NAME_PREVIEW_LIMIT)
  const collapsedRecommendedRemainder = Math.max(0, hiddenRecommendedSuggestions.length - collapsedRecommendedPreview.length)
  const collapsedRecommendedSummary = recommendedSuggestions.length === 1
    ? '1 template stays hidden until this project needs broader coverage.'
    : `${formatTemplateCount(recommendedSuggestions.length)} stay hidden until this project needs broader coverage.`
  const collapsedRecommendedButtonLabel = `Show ${formatTemplateCount(recommendedSuggestions.length)}`
  const hiddenRecommendedPreviewLabel = prioritySuggestions.length > 0 ? 'Still hidden' : 'Also suggested'
  const panelSummary = buildPanelSummary(
    prioritySuggestions.length,
    visibleRecommendedSuggestions.length,
    recommendedSuggestions.length,
  )

  const renderSuggestion = (rec: RecommendedAgent, layout: SuggestionLayout) => {
    const isCustom = customNames.has(recommendedAgentNameKey(rec.name))
    const metadataLabels = buildMetadataLabels(rec)
    const compactMetadataSummary = metadataLabels.join(' • ')
    const style = getSuggestionStyle(getSuggestionTone(rec))

    if (layout === 'compact') {
      return (
        <div
          key={rec.name}
          className="flex flex-col gap-2 rounded-lg border border-border bg-bg-tertiary/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-text-primary">{rec.name}</span>
              {isCustom && (
                <span className={customBadgeClassName}>custom</span>
              )}
            </div>
            {rec.description && (
              <p className="mt-0.5 text-[11px] leading-5 text-text-tertiary">
                {rec.description}
              </p>
            )}
            {compactMetadataSummary && (
              <p className="mt-1.5 font-mono text-[10px] text-text-tertiary">
                {compactMetadataSummary}
              </p>
            )}
          </div>
          <Button
            aria-label={`Use ${rec.name} template`}
            className="w-full shrink-0 sm:w-auto"
            onClick={() => onAddAgent(rec)}
            size="sm"
            variant={style.buttonVariant}
          >
            Use template
          </Button>
        </div>
      )
    }

    return (
      <div
        key={rec.name}
        className={`flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between ${style.cardClassName}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={`text-sm font-medium ${style.nameClassName}`}>{rec.name}</span>
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${style.badgeClassName}`}
            >
              {style.badgeLabel}
            </span>
            {isCustom && (
              <span className={customBadgeClassName}>custom</span>
            )}
          </div>
          {rec.description && (
            <p className="mt-1 text-xs leading-5 text-text-tertiary">
              {rec.description}
            </p>
          )}
          {metadataLabels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {metadataLabels.map(label => (
                <span
                  key={label}
                  className={metadataBadgeClassName}
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <Button
          aria-label={`Use ${rec.name} template`}
          className="w-full shrink-0 sm:w-auto sm:self-start"
          onClick={() => onAddAgent(rec)}
          size="sm"
          variant={style.buttonVariant}
        >
          Use template
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Suggested templates</h3>
          <p className="text-xs text-text-tertiary">
            {panelSummary}
          </p>
        </div>
        <span className={`shrink-0 ${sectionCountClassName}`}>
          {suggestions.length} suggested
        </span>
      </div>
      {prioritySuggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">Start here</p>
            <p className="text-[10px] font-mono text-text-tertiary">{prioritySuggestions.length} priority</p>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {prioritySuggestions.map(rec => renderSuggestion(rec, 'full'))}
          </div>
        </div>
      )}

      {visibleRecommendedSuggestions.length > 0 && (
        <div className={`space-y-2 ${prioritySuggestions.length > 0 ? 'border-t border-border/70 pt-3' : ''}`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">
              {prioritySuggestions.length > 0 ? 'Optional templates' : 'Available now'}
            </p>
            <span className={sectionCountClassName}>
              {formatVisibleTemplateSummary(
                visibleRecommendedSuggestions.length,
                recommendedSuggestions.length,
              )}
            </span>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {visibleRecommendedSuggestions.map(rec => renderSuggestion(rec, 'compact'))}
          </div>
          {(hiddenRecommendedCount > 0 || showExpandedRecommended) && (
            <div className={showHiddenRecommendedPreview ? 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' : 'flex justify-start'}>
              {showHiddenRecommendedPreview && (
                <div className="min-w-0 space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">
                    {hiddenRecommendedPreviewLabel}
                  </p>
                  <RecommendationNamePreview
                    items={collapsedRecommendedPreview}
                    remainder={collapsedRecommendedRemainder}
                  />
                </div>
              )}
              <Button
                aria-expanded={showExpandedRecommended}
                className={showHiddenRecommendedPreview ? 'shrink-0 self-start' : undefined}
                onClick={() => setShowExpandedRecommended(prev => !prev)}
                size="sm"
                variant="ghost"
              >
                {hiddenRecommendedCount > 0 ? `Show ${hiddenRecommendedCount} more` : 'Show fewer'}
              </Button>
            </div>
          )}
        </div>
      )}

      {visibleRecommendedSuggestions.length === 0 && recommendedSuggestions.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">Optional templates</p>
              <span className={sectionCountClassName}>
                {formatVisibleTemplateSummary(0, recommendedSuggestions.length)}
              </span>
            </div>
            <RecommendationNamePreview
              items={collapsedRecommendedPreview}
              remainder={collapsedRecommendedRemainder}
            />
            <p className="text-xs text-text-tertiary">
              {collapsedRecommendedSummary}
            </p>
          </div>
          <Button
            aria-expanded={showExpandedRecommended}
            className="shrink-0"
            onClick={() => setShowExpandedRecommended(true)}
            size="sm"
            variant="ghost"
          >
            {collapsedRecommendedButtonLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
