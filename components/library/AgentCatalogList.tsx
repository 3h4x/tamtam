'use client'

import { useMemo, useState } from 'react'
import { useAgentCatalog, type AgentCatalogClientEntry } from '@/hooks/useAgentCatalog'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'

const TIER_ORDER: Record<string, number> = {
  essential: 0,
  featured: 1,
  recommended: 2,
  none: 3,
}

function tierLabel(tier: AgentCatalogClientEntry['tier']) {
  if (tier === 'essential') return 'Essential'
  if (tier === 'featured') return 'Featured'
  return 'Recommended'
}

function dispatchBadge(dispatch: AgentCatalogClientEntry['dispatch']) {
  if (dispatch === 'internal') {
    return (
      <Pill tone="accent" size="xs" className="rounded-full px-1.5 text-[10px] whitespace-nowrap">
        system
      </Pill>
    )
  }
  return (
    <Pill size="xs" className="rounded-full px-1.5 text-[10px] text-text-tertiary whitespace-nowrap">
      cli
    </Pill>
  )
}

export function AgentCatalogList() {
  const { entries, loading } = useAgentCatalog()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) =>
      `${e.name} ${e.description} ${e.aliases.join(' ')} ${e.skillIds.join(' ')}`
        .toLowerCase()
        .includes(needle),
    )
  }, [entries, search])

  const grouped = useMemo(() => {
    const groups = new Map<string, AgentCatalogClientEntry[]>()
    for (const entry of filtered) {
      const key = entry.autoSeed
        ? 'auto-seeded'
        : entry.tier ?? 'recommended'
      const bucket = groups.get(key) ?? []
      bucket.push(entry)
      groups.set(key, bucket)
    }
    return Array.from(groups.entries()).sort(
      ([a], [b]) => (TIER_ORDER[a] ?? 4) - (TIER_ORDER[b] ?? 4),
    )
  }, [filtered])

  if (loading && entries.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <Spinner size="sm" shrink aria-label="Loading" role="status" />
          <span>Loading agent catalog…</span>
        </div>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <input
          type="search"
          aria-label="Search agent catalog"
          className="w-full sm:max-w-md px-3 py-2 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name, description, or skill"
        />
        <span className="text-xs text-text-tertiary tabular-nums">
          {filtered.length} of {entries.length}
        </span>
      </div>

      {grouped.map(([groupKey, items]) => (
        <section key={groupKey}>
          <div className="flex items-baseline gap-3 mb-1 px-4">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
              {groupKey === 'auto-seeded' ? 'Auto-seeded (system)' : tierLabel(groupKey as AgentCatalogClientEntry['tier'])}
            </h3>
            <span className="text-xs text-text-tertiary tabular-nums">{items.length}</span>
          </div>
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border bg-bg-secondary">
            {items.map((entry) => (
              <AgentCatalogRow key={entry.name} entry={entry} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function AgentCatalogRow({ entry }: { entry: AgentCatalogClientEntry }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,11rem)_auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 hover:bg-bg-tertiary/50 transition-colors">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary truncate" title={entry.name}>
            {entry.name}
          </span>
          {dispatchBadge(entry.dispatch)}
        </div>
        {entry.aliases.length > 0 && (
          <div className="text-[10px] text-text-tertiary mt-0.5 truncate">
            aliases: {entry.aliases.join(', ')}
          </div>
        )}
      </div>

      <div className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap">
        {entry.defaultSchedule || '—'} · {entry.defaultModel}
      </div>

      <div className="min-w-0">
        <p className="text-xs text-text-secondary truncate" title={entry.description}>
          {entry.description}
        </p>
        {entry.skillIds.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.skillIds.map((id) => (
              <Pill
                key={id}
                size="xs"
                className="rounded-full px-1.5 text-[10px] text-text-tertiary font-mono"
                title={id}
              >
                {id}
              </Pill>
            ))}
          </div>
        )}
      </div>

      <div className="text-[10px] text-text-tertiary whitespace-nowrap">
        {entry.autoSeed ? 'all projects' : 'on demand'}
      </div>
    </div>
  )
}
