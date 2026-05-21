'use client';

import type { ReactNode } from 'react';

interface WorkflowStatusPresentation {
  glyph: string;
  className: string;
  spin?: boolean;
}

export function workflowStatusPresentation(status: string): WorkflowStatusPresentation {
  switch (status) {
    case 'completed':
      return { glyph: '✓', className: 'bg-status-success/15 text-status-success border-status-success/30' };
    case 'failed':
      return { glyph: '✗', className: 'bg-status-error/15 text-status-error border-status-error/30' };
    case 'cancelled':
      return { glyph: '!', className: 'bg-status-error/15 text-status-error border-status-error/30' };
    case 'running':
      return { glyph: '⟳', className: 'bg-accent/15 text-accent border-accent/30', spin: true };
    case 'pending':
      return { glyph: '○', className: 'bg-accent/15 text-accent border-accent/30' };
    default:
      return { glyph: '○', className: 'bg-bg-tertiary text-text-tertiary border-border' };
  }
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
