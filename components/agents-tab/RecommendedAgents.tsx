'use client'

import { useState } from 'react'
import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { Button, type ButtonVariant } from '@/components/ui/Button'
import { getModelLabel } from '@/lib/agents/model-aliases'
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

interface MetaBadge {
  label: string
}

type SuggestionLayout = 'full' | 'compact'

const metadataBadgeClassName =
  'rounded-full border border-border bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] tabular-nums text-text-secondary'
const customBadgeClassName =
  'rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-accent'

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

function formatTemplateCount(count: number): string {
  return count === 1 ? '1 template' : `${count} templates`
}

function formatSkillCount(skillIds: string[] | undefined): string | null {
  if (!skillIds?.length) return null
  return skillIds.length === 1 ? '1 skill' : `${skillIds.length} skills`
}

function formatAliasesLabel(aliases: string[] | undefined): string | null {
  if (!aliases?.length) return null
  return aliases.length === 1 ? `legacy name ${aliases[0]}` : `legacy names ${aliases.join(', ')}`
}

function buildMetaBadges(rec: RecommendedAgent): MetaBadge[] {
  const scheduleLabel = formatScheduleLabel(rec.schedule)
  const skillCountLabel = formatSkillCount(rec.skillIds)

  return [
    { label: getModelLabel(rec.model) },
    skillCountLabel ? { label: skillCountLabel } : null,
    scheduleLabel ? { label: scheduleLabel } : null,
  ].filter((badge): badge is MetaBadge => Boolean(badge))
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

  const prioritySuggestions = suggestions.filter(rec => getSuggestionTone(rec) !== 'recommended')
  const recommendedSuggestions = suggestions.filter(rec => getSuggestionTone(rec) === 'recommended')
  const customRecommendedSuggestions = recommendedSuggestions.filter(rec => customNames.has(recommendedAgentNameKey(rec.name)))
  const collapseRecommendedByDefault = prioritySuggestions.length > 0
  const recommendedPreviewLimit = collapseRecommendedByDefault ? 0 : RECOMMENDED_VISIBLE_LIMIT
  const defaultVisibleRecommendedSuggestions = collapseRecommendedByDefault
    ? customRecommendedSuggestions
    : recommendedSuggestions.slice(0, recommendedPreviewLimit)
  const visibleRecommendedSuggestions = showExpandedRecommended
    ? recommendedSuggestions
    : defaultVisibleRecommendedSuggestions
  const hiddenRecommendedCount = Math.max(0, recommendedSuggestions.length - visibleRecommendedSuggestions.length)
  const collapsedRecommendedPreview = recommendedSuggestions.slice(0, COLLAPSED_NAME_PREVIEW_LIMIT)
  const collapsedRecommendedRemainder = Math.max(0, recommendedSuggestions.length - collapsedRecommendedPreview.length)
  const collapsedRecommendedSummary = recommendedSuggestions.length === 1
    ? '1 template stays hidden until this project needs broader coverage.'
    : `${formatTemplateCount(recommendedSuggestions.length)} stay hidden until this project needs broader coverage.`
  const collapsedRecommendedButtonLabel = `Show ${formatTemplateCount(recommendedSuggestions.length)}`

  const renderSuggestion = (rec: RecommendedAgent, layout: SuggestionLayout) => {
    const isCustom = customNames.has(recommendedAgentNameKey(rec.name))
    const metaBadges = buildMetaBadges(rec)
    const aliasesLabel = formatAliasesLabel(rec.aliases)
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
            {(metaBadges.length > 0 || aliasesLabel) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {metaBadges.map(badge => (
                  <span
                    key={badge.label}
                    className={metadataBadgeClassName}
                  >
                    {badge.label}
                  </span>
                ))}
                {aliasesLabel && (
                  <span className="text-[11px] leading-5 text-text-tertiary">
                    {aliasesLabel}
                  </span>
                )}
              </div>
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
          {aliasesLabel && (
            <p className="mt-1 text-[11px] leading-5 text-text-tertiary">
              {aliasesLabel}
            </p>
          )}
          {metaBadges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {metaBadges.map(badge => (
                <span
                  key={badge.label}
                  className={metadataBadgeClassName}
                >
                  {badge.label}
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
            {prioritySuggestions.length > 0
              ? customRecommendedSuggestions.length > 0
                ? 'Start with the priority templates below. Custom templates stay visible; built-in options stay collapsed until you ask for broader coverage.'
                : 'Start with the priority templates below. Optional templates stay collapsed until you ask for broader coverage.'
              : 'Suggested templates stay compact by default. Expand the list only if this project needs broader coverage.'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-mono text-text-tertiary">
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
              {prioritySuggestions.length > 0 ? 'Optional templates' : 'Suggested templates'}
            </p>
            <p className="text-[10px] font-mono text-text-tertiary">
              {prioritySuggestions.length > 0 ? `${recommendedSuggestions.length} optional` : `${recommendedSuggestions.length} recommended`}
            </p>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {visibleRecommendedSuggestions.map(rec => renderSuggestion(rec, 'compact'))}
          </div>
          {(hiddenRecommendedCount > 0 || showExpandedRecommended) && (
            <div className="flex justify-start">
              <Button
                aria-expanded={showExpandedRecommended}
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
            <p className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">Optional templates</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {collapsedRecommendedPreview.map(rec => (
                <span
                  key={rec.name}
                  className="rounded-full border border-border bg-bg-tertiary/60 px-2 py-0.5 text-[10px] font-mono text-text-secondary"
                >
                  {rec.name}
                </span>
              ))}
              {collapsedRecommendedRemainder > 0 && (
                <span className="text-[11px] text-text-tertiary">
                  +{collapsedRecommendedRemainder} more
                </span>
              )}
            </div>
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
