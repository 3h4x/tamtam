'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/Button';
import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';

export interface WorkflowRunsActiveItem {
  id: string;
  name: string;
  rawName: string;
  status: string;
  inputLabel: string;
  inputTitle: string;
  triggerLabel: string;
  durationLabel: string;
  startedLabel: string;
  startedTitle: string;
}

export function WorkflowRunsActivePanel({ items }: { items: WorkflowRunsActiveItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="mb-3 rounded-md border border-accent/30 bg-accent/10 p-3" aria-label="Active workflow runs">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-accent">active now</h3>
        <span className="font-mono text-xs tabular-nums text-text-tertiary">
          {items.length} {items.length === 1 ? 'run' : 'runs'}
        </span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/workflow-runs/${encodeURIComponent(item.id)}`}
            aria-label={`Workflow run ${item.name} for ${item.inputLabel} state ${item.status}`}
            className={buttonVariants({
              surface: 'primary',
              className: '!block min-w-0 !rounded-md !px-3 !py-2 !text-xs !font-normal',
            })}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text-primary" title={item.rawName}>
                  {item.name}
                </div>
                <div className="mt-1 truncate text-text-secondary" title={item.inputTitle}>
                  {item.inputLabel}
                </div>
              </div>
              <WorkflowStatusBadge status={item.status} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-text-tertiary">
              <div className="min-w-0">
                <div className="uppercase tracking-wide">why it ran</div>
                <div className="truncate text-text-secondary" title={item.triggerLabel}>
                  {item.triggerLabel}
                </div>
              </div>
              <div>
                <div className="uppercase tracking-wide">elapsed</div>
                <div className="text-text-secondary tabular-nums">{item.durationLabel}</div>
              </div>
              <div>
                <div className="uppercase tracking-wide">started</div>
                <div className="truncate text-text-secondary" title={item.startedTitle}>
                  {item.startedLabel}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
