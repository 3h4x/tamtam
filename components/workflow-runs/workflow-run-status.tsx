'use client';

import type { ReactNode } from 'react';

interface WorkflowStatusPresentation {
  glyph: string;
  className: string;
  spin?: boolean;
}

// Pre-allocate one object per status. Every workflow-runs list row calls
// this helper; previously each call returned a fresh object literal with
// the same content. Module-load allocates 6 objects once; subsequent calls
// just return the cached reference.
const STATUS_PRESENTATIONS: Record<string, WorkflowStatusPresentation> = {
  completed: { glyph: '✓', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  failed: { glyph: '✗', className: 'bg-status-error/15 text-status-error border-status-error/30' },
  cancelled: { glyph: '!', className: 'bg-status-error/15 text-status-error border-status-error/30' },
  running: { glyph: '⟳', className: 'bg-accent/15 text-accent border-accent/30', spin: true },
  pending: { glyph: '○', className: 'bg-accent/15 text-accent border-accent/30' },
};

const DEFAULT_PRESENTATION: WorkflowStatusPresentation = {
  glyph: '○',
  className: 'bg-bg-tertiary text-text-tertiary border-border',
};

export function workflowStatusPresentation(status: string): WorkflowStatusPresentation {
  return STATUS_PRESENTATIONS[status] ?? DEFAULT_PRESENTATION;
}

export function WorkflowStatusBadge({ status, suffix }: { status: string; suffix?: ReactNode }) {
  const presentation = workflowStatusPresentation(status);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${presentation.className}`}
      title={`status: ${status}`}
      aria-label={`status ${status}`}
    >
      <span className={`leading-none ${presentation.spin ? 'animate-spin' : ''}`} aria-hidden="true">
        {presentation.glyph}
      </span>
      <span>{status}</span>
      {suffix}
    </span>
  );
}
