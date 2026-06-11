'use client';

import { Button } from '@/components/ui/Button';
import { Pill, PillButton, type PillTone } from '@/components/ui/Pill';
import { SearchInput } from '@/components/ui/SearchInput';
import { workflowStatusPresentation } from '@/components/workflow-runs/workflow-run-status';

export const STATUS_FILTERS = ['all', 'completed', 'running', 'pending', 'failed', 'cancelled'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

interface WorkflowRunsFilterPanelProps {
  nameFilter: string;
  statusFilter: StatusFilter;
  statusCounts: Record<StatusFilter, number>;
  attentionStatusCounts: Record<StatusFilter, number>;
  resultsSummary: string;
  onNameFilterChange: (value: string) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  onClearFilters: () => void;
}

interface FilterPresentation {
  glyph: string | null;
  tone: PillTone;
  glyphClassName: string;
}

function workflowFilterPresentation(status: Exclude<StatusFilter, 'all'>): FilterPresentation {
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
    tone: presentation.className.includes('text-status-success')
      ? 'success'
      : presentation.className.includes('text-status-error')
        ? 'error'
        : presentation.className.includes('text-accent')
          ? 'accent'
          : 'neutral',
    glyphClassName,
  };
}

const STATUS_FILTER_PRESENTATIONS: Record<StatusFilter, FilterPresentation> = {
  all: {
    glyph: null,
    tone: 'accent',
    glyphClassName: 'text-text-tertiary',
  },
  completed: workflowFilterPresentation('completed'),
  running: workflowFilterPresentation('running'),
  pending: workflowFilterPresentation('pending'),
  failed: workflowFilterPresentation('failed'),
  cancelled: workflowFilterPresentation('cancelled'),
};

function statusFilterPresentation(status: StatusFilter): FilterPresentation {
  return STATUS_FILTER_PRESENTATIONS[status];
}

export function WorkflowRunsFilterPanel({
  nameFilter,
  statusFilter,
  statusCounts,
  attentionStatusCounts,
  resultsSummary,
  onNameFilterChange,
  onStatusFilterChange,
  onClearFilters,
}: WorkflowRunsFilterPanelProps) {
  const nameNeedle = nameFilter.trim().toLowerCase();
  const hasActiveFilters = nameNeedle.length > 0 || statusFilter !== 'all';
  const activeStatusPresentation = statusFilter !== 'all' ? statusFilterPresentation(statusFilter) : null;
  const attentionStatuses = STATUS_FILTERS
    .filter((status) => status !== 'all' && attentionStatusCounts[status] > 0)
    .map((status) => ({ status, count: attentionStatusCounts[status] }));
  const attentionCount = attentionStatuses.reduce((total, item) => total + item.count, 0);

  return (
    <div className="mb-3 rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="relative max-w-md">
              <SearchInput
                value={nameFilter}
                onChange={(event) => onNameFilterChange(event.target.value)}
                placeholder="Filter workflow, project, trigger, outcome…"
                style={{ paddingRight: '2rem' }}
              />
              {nameFilter ? (
                <Button
                  type="button"
                  onClick={() => onNameFilterChange('')}
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  ×
                </Button>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
              <span className="font-mono">{resultsSummary}</span>
              {statusCounts.running > 0 ? (
                <span className="font-mono text-accent">{statusCounts.running} running</span>
              ) : null}
              {hasActiveFilters ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="font-mono"
                  onClick={onClearFilters}
                >
                  clear filters
                </Button>
              ) : null}
            </div>
          </div>
          {hasActiveFilters ? (
            <div className="flex flex-wrap gap-1.5 lg:max-w-[45%] lg:justify-end">
              {nameNeedle ? (
                <Pill
                  tone="neutral"
                  className="max-w-full"
                  title={nameFilter.trim()}
                >
                  <span className="text-text-tertiary">query</span>
                  <span className="max-w-[20rem] truncate font-mono text-text-primary">{nameFilter.trim()}</span>
                </Pill>
              ) : null}
              {activeStatusPresentation ? (
                <Pill tone={activeStatusPresentation.tone}>
                  {activeStatusPresentation.glyph ? (
                    <span className="leading-none" aria-hidden="true">
                      {activeStatusPresentation.glyph}
                    </span>
                  ) : null}
                  <span>status</span>
                  <span className="font-mono">{statusFilter}</span>
                </Pill>
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
            <PillButton
              key={status}
              type="button"
              onClick={() => onStatusFilterChange(status)}
              aria-pressed={selected}
              tone={presentation.tone}
              active={selected}
              className="px-2.5"
            >
              {presentation.glyph ? (
                <span className={`leading-none ${selected ? '' : presentation.glyphClassName}`} aria-hidden="true">
                  {presentation.glyph}
                </span>
              ) : null}
              <span>{status}</span>
              <span className="font-mono tabular-nums text-text-tertiary">{statusCounts[status]}</span>
            </PillButton>
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
                <PillButton
                  key={status}
                  type="button"
                  onClick={() => onStatusFilterChange(status)}
                  aria-label={`Show ${status} workflow runs`}
                  tone={presentation.tone}
                  size="xs"
                  active={selected}
                  inactiveStyle="subtle"
                  className={selected ? undefined : 'hover:bg-bg-tertiary'}
                >
                  {presentation.glyph ? (
                    <span className={`leading-none ${selected ? '' : presentation.glyphClassName}`} aria-hidden="true">
                      {presentation.glyph}
                    </span>
                  ) : null}
                  <span>{status}</span>
                  <span className="font-mono tabular-nums text-text-tertiary">{count}</span>
                </PillButton>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
