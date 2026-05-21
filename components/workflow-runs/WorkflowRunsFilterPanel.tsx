'use client';

import { workflowStatusPresentation } from '@/components/workflow-runs/workflow-run-status';

export const STATUS_FILTERS = ['all', 'completed', 'running', 'pending', 'failed', 'cancelled'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

interface WorkflowRunsFilterPanelProps {
  nameFilter: string;
  statusFilter: StatusFilter;
  statusCounts: Record<StatusFilter, number>;
  resultsSummary: string;
  onNameFilterChange: (value: string) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  onClearFilters: () => void;
}

function statusFilterPresentation(status: StatusFilter): {
  glyph: string | null;
  activeClassName: string;
  glyphClassName: string;
} {
  switch (status) {
    case 'completed':
      return workflowFilterPresentation(status);
    case 'failed':
    case 'cancelled':
      return workflowFilterPresentation(status);
    case 'running':
    case 'pending':
      return workflowFilterPresentation(status);
    case 'all':
      return {
        glyph: null,
        activeClassName: 'border-accent bg-accent/10 text-accent',
        glyphClassName: 'text-text-tertiary',
      };
  }
}

function workflowFilterPresentation(status: Exclude<StatusFilter, 'all'>) {
  const presentation = workflowStatusPresentation(status);
  const glyphClassName = presentation.className.includes('text-status-success')
    ? 'text-status-success'
    : presentation.className.includes('text-status-error')
      ? 'text-status-error'
      : presentation.className.includes('text-accent')
        ? 'text-accent'
        : 'text-text-tertiary';
  return {
    glyph: presentation.glyph,
    activeClassName: presentation.className,
    glyphClassName,
  };
}

export function WorkflowRunsFilterPanel({
  nameFilter,
  statusFilter,
  statusCounts,
  resultsSummary,
  onNameFilterChange,
  onStatusFilterChange,
  onClearFilters,
}: WorkflowRunsFilterPanelProps) {
  const nameNeedle = nameFilter.trim().toLowerCase();
  const hasActiveFilters = nameNeedle.length > 0 || statusFilter !== 'all';
  const activeStatusPresentation = statusFilter !== 'all' ? statusFilterPresentation(statusFilter) : null;
  const attentionStatuses = (['failed', 'cancelled'] as const)
    .filter((status) => statusCounts[status] > 0)
    .map((status) => ({ status, count: statusCounts[status] }));
  const attentionCount = attentionStatuses.reduce((total, item) => total + item.count, 0);

  return (
    <div className="mb-3 rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="relative max-w-md">
              <input
                type="text"
                placeholder="Filter workflow, project, trigger, outcome…"
                value={nameFilter}
                onChange={(e) => onNameFilterChange(e.target.value)}
                className="focus-ring w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 pr-8 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
              {nameFilter ? (
                <button
                  type="button"
                  onClick={() => onNameFilterChange('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-text-tertiary transition-colors hover:text-text-primary"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  ×
                </button>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
              <span className="font-mono">{resultsSummary}</span>
              {statusCounts.running > 0 ? (
                <span className="font-mono text-accent">{statusCounts.running} running</span>
              ) : null}
              {hasActiveFilters ? (
                <button
                  type="button"
                  className="font-mono text-accent transition-colors hover:text-accent-hover"
                  onClick={onClearFilters}
                >
                  clear filters
                </button>
              ) : null}
            </div>
          </div>
          {hasActiveFilters ? (
            <div className="flex flex-wrap gap-1.5 lg:max-w-[45%] lg:justify-end">
              {nameNeedle ? (
                <span
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary"
                  title={nameFilter.trim()}
                >
                  <span className="text-text-tertiary">query</span>
                  <span className="max-w-[20rem] truncate font-mono text-text-primary">{nameFilter.trim()}</span>
                </span>
              ) : null}
              {activeStatusPresentation ? (
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${activeStatusPresentation.activeClassName}`}>
                  {activeStatusPresentation.glyph ? (
                    <span className="leading-none" aria-hidden="true">
                      {activeStatusPresentation.glyph}
                    </span>
                  ) : null}
                  <span>status</span>
                  <span className="font-mono">{statusFilter}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 p-1.5" role="group" aria-label="Status filter">
        {STATUS_FILTERS.map((status) => {
          const presentation = statusFilterPresentation(status);
          const selected = statusFilter === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() => onStatusFilterChange(status)}
              aria-pressed={selected}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                selected
                  ? presentation.activeClassName
                  : 'border-transparent bg-transparent text-text-secondary hover:border-border hover:bg-bg-primary hover:text-text-primary'
              }`}
            >
              {presentation.glyph ? (
                <span className={`leading-none ${selected ? '' : presentation.glyphClassName}`} aria-hidden="true">
                  {presentation.glyph}
                </span>
              ) : null}
              <span>{status}</span>
              <span className="font-mono tabular-nums text-text-tertiary">{statusCounts[status]}</span>
            </button>
          );
        })}
      </div>
      {attentionCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs">
          <span className="font-medium text-status-error">needs attention</span>
          <span className="font-mono text-text-tertiary tabular-nums">{attentionCount} recent</span>
          <div className="ml-0 flex flex-wrap gap-1 sm:ml-auto">
            {attentionStatuses.map(({ status, count }) => {
              const presentation = statusFilterPresentation(status);
              const selected = statusFilter === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => onStatusFilterChange(status)}
                  aria-label={`Show ${status} workflow runs`}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 transition-colors ${
                    selected
                      ? presentation.activeClassName
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                >
                  {presentation.glyph ? (
                    <span className={`leading-none ${selected ? '' : presentation.glyphClassName}`} aria-hidden="true">
                      {presentation.glyph}
                    </span>
                  ) : null}
                  <span>{status}</span>
                  <span className="font-mono tabular-nums text-text-tertiary">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
