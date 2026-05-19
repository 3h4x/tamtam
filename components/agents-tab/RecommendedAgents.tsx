'use client'

import type { AgentTemplateRecord } from '@/components/SettingsPage'
import { recommendedAgentNameKey, recommendedAgentNameKeys } from '@/lib/agents/recommended-agents'

interface RecommendedAgent extends AgentTemplateRecord {
  aliases?: string[]
  skillIds: string[]
  essential?: boolean
  featured?: boolean
}

interface RecommendedAgentsProps {
  agents: { name: string }[]
  customTemplates: AgentTemplateRecord[]
  recommendedAgents: RecommendedAgent[]
  onAddAgent: (rec: AgentTemplateRecord) => void
}

export function RecommendedAgents({ agents, customTemplates, recommendedAgents, onAddAgent }: RecommendedAgentsProps) {
  const existingNames = new Set(agents.map(a => recommendedAgentNameKey(a.name)))
  const customNames = new Set(customTemplates.map(t => recommendedAgentNameKey(t.name)))
  const merged = [
    ...customTemplates,
    ...recommendedAgents.filter(r => !recommendedAgentNameKeys(r).some(name => customNames.has(name))),
  ]
  const suggestions = merged.filter(r => !recommendedAgentNameKeys(r as RecommendedAgent).some(name => existingNames.has(name)))
  if (suggestions.length === 0) return null

  const essential = suggestions.filter(r => (r as RecommendedAgent).essential)
  const featured = suggestions.filter(r => (r as RecommendedAgent).featured)
  const regular = suggestions.filter(r => !(r as RecommendedAgent).essential && !(r as RecommendedAgent).featured)

  return (
    <div className="mt-2 flex flex-col gap-2">
      {essential.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-status-warning/80 uppercase tracking-wider">Essential</h3>
          {essential.map(rec => (
            <div
              key={rec.name}
              className="p-3 rounded-lg border border-status-warning/40 bg-status-warning/5 flex items-center justify-between gap-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-medium text-sm text-status-warning">{rec.name}</span>
                {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning/80 shrink-0">every {rec.schedule}</span>}
                {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
              </div>
              <button
                aria-label={`Add ${rec.name} agent`}
                className="px-3 py-1.5 text-xs border border-status-warning/50 rounded-md text-status-warning hover:bg-status-warning/10 transition-colors cursor-pointer shrink-0"
                onClick={() => onAddAgent(rec)}
              >
                Add
              </button>
            </div>
          ))}
        </>
      )}
      {featured.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-accent/80 uppercase tracking-wider">Featured</h3>
          {featured.map(rec => (
            <div
              key={rec.name}
              className="p-3 rounded-lg border border-accent/40 bg-accent/5 flex items-center justify-between gap-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-medium text-sm text-accent">{rec.name}</span>
                {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent/80 shrink-0">every {rec.schedule}</span>}
                {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
              </div>
              <button
                aria-label={`Add ${rec.name} agent`}
                className="px-3 py-1.5 text-xs border border-accent/50 rounded-md text-accent hover:bg-accent/10 transition-colors cursor-pointer shrink-0"
                onClick={() => onAddAgent(rec)}
              >
                Add
              </button>
            </div>
          ))}
        </>
      )}
      {regular.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mt-1">Recommended</h3>
          {regular.map(rec => {
            const isCustom = customNames.has(recommendedAgentNameKey(rec.name))
            return (
              <div
                key={rec.name}
                className="p-3 rounded-lg border border-border border-dashed bg-bg-secondary/50 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-medium text-sm text-text-secondary">{rec.name}</span>
                  {isCustom && <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">custom</span>}
                  {rec.schedule && <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary shrink-0">every {rec.schedule}</span>}
                  {rec.description && <span className="text-xs text-text-tertiary truncate hidden sm:block">{rec.description}</span>}
                </div>
                <button
                  aria-label={`Add ${rec.name} agent`}
                  className="px-3 py-1.5 text-xs border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors cursor-pointer shrink-0"
                  onClick={() => onAddAgent(rec)}
                >
                  Add
                </button>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
