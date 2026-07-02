'use client'

import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/Button'

type EmptyMode = 'empty' | 'search' | 'running' | 'failed' | 'filtered'

interface ProjectRunsEmptyStateProps {
  projectName: string
  mode: EmptyMode
  search: string
  activeFilterLabel: string
  totalEntries: number
  runningCount: number
  failedCount: number
  onClearFilters: () => void
}

function LoadingRow({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0" style={{ opacity: compact ? 0.68 : 1 }}>
      <div className="skeleton mt-0.5 h-5 w-5 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="skeleton h-5 w-14 shrink-0 rounded" />
          <div className="skeleton h-4 w-48 max-w-[70%] rounded" />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <div className="skeleton h-3 w-24 rounded" />
          <div className="skeleton h-3 w-16 rounded" />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <div className="skeleton h-5 w-16 rounded" />
          {!compact && <div className="skeleton h-5 w-20 rounded" />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <div className="skeleton h-4 w-12 rounded" />
        <div className="skeleton h-3 w-24 rounded" />
      </div>
    </div>
  )
}

export function ProjectRunsLoadingState() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading runs">
      <div className="rounded-lg border border-border bg-bg-secondary">
        <div className="grid gap-3 border-b border-border p-3 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-start">
          <div>
            <div className="skeleton h-8 w-full rounded-md" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="skeleton h-3 w-32 rounded" />
              <div className="skeleton h-3 w-20 rounded" />
              <div className="skeleton h-3 w-24 rounded" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[520px]">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="rounded-md border border-border bg-bg-primary px-3 py-2">
                <div className="skeleton h-3 w-14 rounded" />
                <div className="mt-2 skeleton h-5 w-20 rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 overflow-hidden p-1">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className="skeleton h-7 rounded-md"
              style={{ width: `${index < 3 ? 64 : 74}px`, opacity: 1 - index * 0.08 }}
            />
          ))}
        </div>
      </div>

      {[
        { label: 'today', rows: 4 },
        { label: 'yesterday', rows: 3 },
      ].map((group, groupIndex) => (
        <div key={group.label}>
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <div className="skeleton h-3 w-20 rounded" />
            <div className="skeleton h-3 w-6 rounded" />
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-bg-primary">
            {Array.from({ length: group.rows }).map((_, rowIndex) => (
              <LoadingRow key={`${group.label}:${rowIndex}`} compact={groupIndex === 1 && rowIndex > 0} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ProjectRunsEmptyState({
  projectName,
  mode,
  search,
  activeFilterLabel,
  totalEntries,
  runningCount,
  failedCount,
  onClearFilters,
}: ProjectRunsEmptyStateProps) {
  const queryValue = search.trim()

  const title = (() => {
    switch (mode) {
      case 'empty':
        return 'No runs yet'
      case 'search':
        return 'No runs match this search'
      case 'running':
        return 'Nothing is running right now'
      case 'failed':
        return 'No runs need attention'
      default:
        return `No ${activeFilterLabel.toLowerCase()} runs in view`
    }
  })()

  const detail = (() => {
    switch (mode) {
      case 'empty':
        return 'Start work from Terminal or trigger a release. New runs, verdicts, and durations will show up here.'
      case 'search':
        return `Nothing in ${activeFilterLabel.toLowerCase()} matches “${queryValue}”.`
      case 'running':
        return 'This project has no active terminal, agent, or pipeline work at the moment.'
      case 'failed':
        return 'Visible runs are either done cleanly or still in progress.'
      default:
        return 'This filter is empty for the current history window.'
    }
  })()

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-xs text-text-secondary">{detail}</div>
      </div>

      <div className="grid gap-2 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">entries</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-text-primary">{totalEntries}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">running</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-status-info">{runningCount}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">needs attention</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-status-error">{failedCount}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{queryValue ? 'query' : 'view'}</div>
          <div
            className="mt-1 truncate font-mono text-sm font-semibold text-text-primary"
            title={queryValue || activeFilterLabel}
          >
            {queryValue || activeFilterLabel}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {mode === 'empty' ? (
          <>
            <Link
              href={`/project/${encodeURIComponent(projectName)}/terminal`}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Open Terminal
            </Link>
            <Link
              href={`/pipeline?project=${encodeURIComponent(projectName)}`}
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
            >
              Open Pipeline
            </Link>
          </>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
