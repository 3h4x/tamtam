'use client'

import { Button } from '@/components/ui/Button'
import { PillButton } from '@/components/ui/Pill'
import { SearchField } from '@/components/ui/SearchField'
import { formatTokens, formatCost } from '@/components/project-runs/formatting'
import { KIND_LABEL } from '@/components/project-runs/kinds'
import type { JobCountsResponse } from '@/components/project-runs/formatting'
import { filterKey } from '@/components/project-runs/filters'
import type { Filter } from '@/components/project-runs/filters'

interface RunsHeaderProps {
  search: string
  onSearchChange: (value: string) => void
  filter: Filter
  onFilterChange: (filter: Filter) => void
  onClearFilters: () => void
  filteredCount: number
  entriesCount: number
  totalJobs: number
  summary: JobCountsResponse | null
  loadedTotals: { tokens: number; running: number; costUsd: number }
  thisMonthCost: number
  counts: Record<string, number>
  // Grouped-view "show all jobs" toggle: reveals internal plumbing rows
  // (mark-dod-verify) that are hidden by default. Only meaningful while the
  // feed is grouped by work unit.
  groupingActive: boolean
  showAllJobs: boolean
  onToggleShowAll: () => void
  hiddenInternalCount: number
}

export function RunsHeader({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  onClearFilters,
  filteredCount,
  entriesCount,
  totalJobs,
  summary,
  loadedTotals,
  thisMonthCost,
  counts,
  groupingActive,
  showAllJobs,
  onToggleShowAll,
  hiddenInternalCount,
}: RunsHeaderProps) {
  return (
    <div className="mb-3 rounded-lg border border-border bg-bg-secondary">
      <div className="grid gap-3 border-b border-border p-3 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-start">
      <div>
        <SearchField
          value={search}
          onChange={onSearchChange}
          placeholder="Search prompts, models, session ids…"
          leadingGlyph="⌕"
          inputClassName="w-full pl-8 pr-8 py-1.5 text-sm bg-bg-primary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
        />
        <div className="mt-2 flex items-center gap-2 text-[11px] text-text-tertiary">
          <span className="font-mono">
            showing {filteredCount} of {summary?.total ?? (totalJobs || entriesCount)}
          </span>
          {(summary?.byStatus.running ?? loadedTotals.running) > 0 && (
            <span className="font-mono text-status-info">
              {summary?.byStatus.running ?? loadedTotals.running} running
            </span>
          )}
          {(search.trim() || filter.kind !== 'all') && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="font-mono text-[11px]"
              onClick={onClearFilters}
            >
              clear filters
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[520px]">
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">entries</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{summary?.total ?? entriesCount}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">running</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-status-info tabular-nums">{summary?.byStatus.running ?? loadedTotals.running}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">tokens</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{formatTokens(summary?.tokens.total ?? loadedTotals.tokens)}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2" title="Total cost for all runs this calendar month">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">month cost</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-accent tabular-nums">{formatCost(thisMonthCost)}</div>
        </div>
      </div>
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto p-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" style={{ scrollbarWidth: 'thin' }}>
        {([
          { f: { kind: 'all' } as Filter, label: 'all', tone: 'accent' },
          { f: { kind: 'running' } as Filter, label: 'running', tone: 'info' },
          { f: { kind: 'failed' } as Filter, label: 'failed', tone: 'error' },
        ] as const).map(({ f, label, tone }) => {
          const count = counts[f.kind] ?? 0
          if ((f.kind === 'running' || f.kind === 'failed') && count === 0 && filterKey(filter) !== filterKey(f)) return null
          const active = filterKey(filter) === filterKey(f)
          return (
            <PillButton
              key={label}
              type="button"
              tone={tone}
              size="sm"
              active={active}
              className={[
                'shrink-0 px-2.5 font-mono',
                !active && tone === 'info' ? 'hover:text-status-info' : undefined,
                !active && tone === 'error' ? 'hover:text-status-error' : undefined,
              ].filter(Boolean).join(' ')}
              onClick={() => onFilterChange(f)}
            >
              {label} <span className="opacity-70">{count}</span>
            </PillButton>
          )
        })}
        <span className="shrink-0 h-5 w-px bg-border mx-1" aria-hidden />
        {(['run', 'release', 'review', 'test', 'fix', 'fix-ci', 'commit', 'push', 'mark-dod', 'pr-wait', 'agent', 'other'] as const).map((b) => {
          const count = counts[b] ?? 0
          const active = filter.kind === 'bucket' && filter.bucket === b
          if (count === 0 && !active) return null
          return (
            <PillButton
              key={b}
              type="button"
              tone="accent"
              size="sm"
              active={active}
              className="shrink-0 px-2.5 font-mono"
              onClick={() => onFilterChange({ kind: 'bucket', bucket: b })}
            >
              {KIND_LABEL[b]} <span className="opacity-70">{count}</span>
            </PillButton>
          )
        })}
        {groupingActive && (hiddenInternalCount > 0 || showAllJobs) && (
          <>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <PillButton
              type="button"
              tone="neutral"
              size="sm"
              active={showAllJobs}
              className="shrink-0 px-2.5 font-mono"
              onClick={onToggleShowAll}
              title={showAllJobs
                ? 'Hide internal plumbing jobs (mark-dod-verify) and group by work unit'
                : `Show ${hiddenInternalCount} hidden internal job${hiddenInternalCount === 1 ? '' : 's'} (mark-dod-verify) at the top level`}
            >
              {showAllJobs ? 'showing all' : 'show all jobs'}
              {!showAllJobs && hiddenInternalCount > 0 && <span className="opacity-70"> +{hiddenInternalCount}</span>}
            </PillButton>
          </>
        )}
      </div>
    </div>
  )
}
