'use client';

import Link from 'next/link';
import { ErrorCallout } from '@/components/ui/ErrorCallout';
import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';

export interface WorkflowRunsAttentionItem {
  id: string;
  name: string;
  rawName: string;
  status: string;
  inputLabel: string;
  inputTitle: string;
  triggerLabel: string;
  outcomeLabel: string;
  outcomeTitle: string;
  outcomeDetailLabel?: string;
  outcomeDetailTitle?: string;
  finishedLabel: string;
  finishedTitle: string;
}

const visibleLimit = 4;

export function WorkflowRunsAttentionPanel({ items }: { items: WorkflowRunsAttentionItem[] }) {
  if (items.length === 0) return null;

  const visibleItems = items.slice(0, visibleLimit);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <section className="mb-3" aria-label="Workflow runs needing attention">
      <ErrorCallout padding="none" radius="md" preWrap={false} className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-2 border-b border-status-error/20 px-3 py-2">
          <h3 className="text-sm font-medium text-status-error">needs attention</h3>
          <span className="font-mono text-xs tabular-nums text-text-tertiary">
            {items.length} {items.length === 1 ? 'run' : 'runs'}
          </span>
          {hiddenCount > 0 ? (
            <span className="text-xs text-text-tertiary">
              showing latest {visibleItems.length}
            </span>
          ) : null}
        </div>
        <div className="divide-y divide-border bg-bg-primary">
          {visibleItems.map((item) => (
            <Link
              key={item.id}
              href={`/workflow-runs/${encodeURIComponent(item.id)}`}
              aria-label={`Workflow run ${item.name} for ${item.inputLabel} state ${item.status}`}
              className="grid gap-2 px-3 py-2 text-xs transition-colors hover:bg-bg-tertiary sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <WorkflowStatusBadge status={item.status} />
                  <span className="truncate text-sm font-medium text-text-primary" title={item.rawName}>
                    {item.name}
                  </span>
                </div>
                <div className="mt-1 truncate text-text-secondary" title={item.inputTitle}>
                  {item.inputLabel}
                </div>
              </div>
              <div className="min-w-0">
                <div className="uppercase tracking-wide text-text-tertiary">why it ran</div>
                <div className="truncate text-text-secondary" title={item.triggerLabel}>
                  {item.triggerLabel}
                </div>
              </div>
              <div className="min-w-0">
                <div className="uppercase tracking-wide text-text-tertiary">outcome</div>
                <div className="truncate font-mono text-status-error" title={item.outcomeTitle}>
                  {item.outcomeLabel}
                </div>
                {item.outcomeDetailLabel ? (
                  <div className="mt-1 truncate text-text-secondary" title={item.outcomeDetailTitle ?? item.outcomeDetailLabel}>
                    {item.outcomeDetailLabel}
                  </div>
                ) : null}
              </div>
              <div className="min-w-0 sm:text-right">
                <div className="uppercase tracking-wide text-text-tertiary">finished</div>
                <div className="font-mono text-text-secondary tabular-nums" title={item.finishedTitle}>
                  {item.finishedLabel}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </ErrorCallout>
    </section>
  );
}
