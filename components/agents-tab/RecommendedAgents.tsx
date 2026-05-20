'use client'

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

interface SectionConfig {
  key: 'essential' | 'featured' | 'recommended'
  title: string
  items: RecommendedAgent[]
  titleClassName: string
  cardClassName: string
  nameClassName: string
  buttonVariant: ButtonVariant
}

function formatScheduleLabel(schedule: string | undefined): string {
  return schedule ? `every ${schedule}` : 'manual'
}

function formatSkillCount(skillIds: string[] | undefined): string | null {
  if (!skillIds?.length) return null
  return skillIds.length === 1 ? '1 skill' : `${skillIds.length} skills`
}

function formatAliasesLabel(aliases: string[] | undefined): string | null {
  if (!aliases?.length) return null
  return aliases.join(', ')
}

export function RecommendedAgents({ agents, customTemplates, recommendedAgents, onAddAgent }: RecommendedAgentsProps) {
  const existingNames = new Set(agents.map(a => recommendedAgentNameKey(a.name)))
  const customNames = new Set(customTemplates.map(t => recommendedAgentNameKey(t.name)))
  const merged: RecommendedAgent[] = [
    ...customTemplates,
    ...recommendedAgents.filter(r => !recommendedAgentNameKeys(r).some(name => customNames.has(name))),
  ]
  const suggestions = merged.filter(r => !recommendedAgentNameKeys(r).some(name => existingNames.has(name)))
  if (suggestions.length === 0) return null

  const sections: SectionConfig[] = [
    {
      key: 'essential',
      title: 'Essential',
      items: suggestions.filter(r => r.essential),
      titleClassName: 'text-status-warning/80',
      cardClassName: 'border-status-warning/40 bg-status-warning/5',
      nameClassName: 'text-status-warning',
      buttonVariant: 'warning',
    },
    {
      key: 'featured',
      title: 'Featured',
      items: suggestions.filter(r => r.featured),
      titleClassName: 'text-accent/80',
      cardClassName: 'border-accent/40 bg-accent/5',
      nameClassName: 'text-accent',
      buttonVariant: 'primary',
    },
    {
      key: 'recommended',
      title: 'Recommended',
      items: suggestions.filter(r => !r.essential && !r.featured),
      titleClassName: 'text-text-tertiary',
      cardClassName: 'border-border border-dashed bg-bg-secondary/50',
      nameClassName: 'text-text-secondary',
      buttonVariant: 'secondary',
    },
  ]

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary/40 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-text-tertiary">
          Missing templates for this project. Start from a default, then adjust it in the editor.
        </p>
        <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-mono text-text-tertiary">
          {suggestions.length} available
        </span>
      </div>
      {sections.map(section => {
        if (section.items.length === 0) return null

        return (
          <section key={section.key} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${section.titleClassName}`}>
                {section.title}
              </h3>
              <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
                {section.items.length}
              </span>
            </div>
            <div className="grid gap-2 xl:grid-cols-2">
              {section.items.map(rec => {
                const isCustom = customNames.has(recommendedAgentNameKey(rec.name))
                const skillCountLabel = formatSkillCount(rec.skillIds)
                const aliasesLabel = formatAliasesLabel(rec.aliases)

                return (
                  <div
                    key={rec.name}
                    className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${section.cardClassName}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={`text-sm font-medium ${section.nameClassName}`}>{rec.name}</span>
                        {isCustom && (
                          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                            custom
                          </span>
                        )}
                      </div>
                      {rec.description && (
                        <p className="mt-1 text-xs leading-5 text-text-tertiary">
                          {rec.description}
                        </p>
                      )}
                      {aliasesLabel && (
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          also matches <span className="font-mono text-text-secondary">{aliasesLabel}</span>
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                          {getModelLabel(rec.model)}
                        </span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                          {formatScheduleLabel(rec.schedule)}
                        </span>
                        {skillCountLabel && (
                          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                            {skillCountLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      aria-label={`Add ${rec.name} agent`}
                      className="shrink-0 self-start"
                      onClick={() => onAddAgent(rec)}
                      size="sm"
                      variant={section.buttonVariant}
                    >
                      Add
                    </Button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
