'use client';

import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';

export interface WorkflowStepAttentionItem {
  stepId: string;
  name: string;
  rawName: string;
  status: string;
  attempt: number;
  durationLabel: string;
  completedLabel: string;
  error: string | null;
}

export function workflowStepAnchorId(stepId: string, surface: 'mobile' | 'desktop'): string {
  return `workflow-step-${surface}-${encodeURIComponent(stepId)}`;
}

export function workflowStepNeedsAttention(step: { status: string; error: string | null }): boolean {
  return step.status === 'failed' || step.status === 'cancelled' || step.error != null;
}

function summarizeStepIssue(step: WorkflowStepAttentionItem): string {
  if (step.error) {
    return step.error.split('\n')[0].slice(0, 96);
  }
  if (step.status === 'cancelled') return 'cancelled before completion';
  return `status ${step.status}`;
}

export function WorkflowStepAttentionPanel({ steps }: { steps: WorkflowStepAttentionItem[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium text-status-error">needs attention</h3>
        <span className="font-mono text-xs tabular-nums text-text-tertiary">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {steps.map((step) => (
          <div key={step.stepId} className="contents">
            <StepAttentionCard
              step={step}
              href={`#${workflowStepAnchorId(step.stepId, 'mobile')}`}
              className="sm:hidden"
            />
            <StepAttentionCard
              step={step}
              href={`#${workflowStepAnchorId(step.stepId, 'desktop')}`}
              className="hidden sm:block"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepAttentionCard({
  step,
  href,
  className,
}: {
  step: WorkflowStepAttentionItem;
  href: string;
  className: string;
}) {
  return (
    <a
      href={href}
      className={`min-w-0 rounded-md border border-status-error/20 bg-bg-primary px-3 py-2 text-xs transition-colors hover:bg-bg-tertiary ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-text-primary" title={step.rawName}>
            {step.name}
          </div>
          <div className="mt-1 truncate text-text-secondary" title={step.error ?? summarizeStepIssue(step)}>
            {summarizeStepIssue(step)}
          </div>
        </div>
        <WorkflowStatusBadge status={step.status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-tertiary">
        <span>attempt {step.attempt}</span>
        <span>{step.durationLabel}</span>
        <span>{step.completedLabel}</span>
      </div>
    </a>
  );
}
