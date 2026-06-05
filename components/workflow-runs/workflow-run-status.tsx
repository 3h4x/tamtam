'use client';

import type { ReactNode } from 'react';
import { Pill, type PillTone } from '@/components/ui/Pill';

interface WorkflowStatusPresentation {
  glyph: string;
  tone: PillTone;
  className: string;
  spin?: boolean;
}

// Pre-allocate one object per status. Every workflow-runs list row calls
// this helper, so module-load builds these once and each call returns the
// cached reference instead of a fresh object literal.
const STATUS_PRESENTATIONS: Record<string, WorkflowStatusPresentation> = {
  completed: { glyph: '✓', tone: 'success', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  failed: { glyph: '✗', tone: 'error', className: 'bg-status-error/15 text-status-error border-status-error/30' },
  cancelled: { glyph: '!', tone: 'error', className: 'bg-status-error/15 text-status-error border-status-error/30' },
  running: { glyph: '⟳', tone: 'accent', className: 'bg-accent/15 text-accent border-accent/30', spin: true },
  pending: { glyph: '○', tone: 'accent', className: 'bg-accent/15 text-accent border-accent/30' },
};

const DEFAULT_PRESENTATION: WorkflowStatusPresentation = {
  glyph: '○',
  tone: 'neutral',
  className: 'bg-bg-tertiary text-text-tertiary border-border',
};

export function workflowStatusPresentation(status: string): WorkflowStatusPresentation {
  return STATUS_PRESENTATIONS[status] ?? DEFAULT_PRESENTATION;
}

export function WorkflowStatusBadge({ status, suffix }: { status: string; suffix?: ReactNode }) {
  const presentation = workflowStatusPresentation(status);

  return (
    <Pill
      tone={presentation.tone}
      size="xs"
      className={`shrink-0 whitespace-nowrap rounded px-1.5 ${presentation.className}`}
      title={`status: ${status}`}
      aria-label={`status ${status}`}
    >
      <span className={`leading-none ${presentation.spin ? 'animate-spin' : ''}`} aria-hidden="true">
        {presentation.glyph}
      </span>
      <span>{status}</span>
      {suffix}
    </Pill>
  );
}
