'use client';

import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';
import { humanizeEmbeddedNames } from '@/components/workflow-runs/humanize';
import { ErrorCallout } from '@/components/ui/ErrorCallout';

export interface WorkflowStepAttentionItem {
  stepId: string;
  name: string;
  rawName: string;
  status: string;
  attempt: number;
  durationLabel: string;
  completedLabel: string;
  error: string | null;
  output?: unknown;
}

export function workflowStepAnchorId(stepId: string, surface: 'mobile' | 'desktop'): string {
  return `workflow-step-${surface}-${encodeURIComponent(stepId)}`;
}

function stepOutputExitCode(output: unknown): number | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const exitCode = (output as Record<string, unknown>).exitCode;
  return typeof exitCode === 'number' ? exitCode : null;
}

function stepOutputDetail(output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;
  for (const key of ['detail', 'summary', 'message']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return humanizeEmbeddedNames(value.trim()).slice(0, 96);
    }
  }
  return null;
}

export function workflowStepNeedsAttention(step: {
  status: string;
  error: string | null;
  output?: unknown;
}): boolean {
  const exitCode = stepOutputExitCode(step.output);
  return (
    step.status === 'failed' ||
    step.status === 'cancelled' ||
    step.error != null ||
    (exitCode != null && exitCode !== 0)
  );
}

function summarizeStepIssue(step: WorkflowStepAttentionItem): string {
  if (step.error) {
    // indexOf + slice avoids allocating an array of every line just to read
    // the first one (matters for long multi-line stack-trace errors).
    const nl = step.error.indexOf('\n');
    const firstLine = nl >= 0 ? step.error.slice(0, nl) : step.error;
    return humanizeEmbeddedNames(firstLine).slice(0, 96);
  }
  if (step.status === 'cancelled') return 'cancelled before completion';
  const exitCode = stepOutputExitCode(step.output);
  if (exitCode != null && exitCode !== 0) {
    const detail = stepOutputDetail(step.output);
    return detail ? `exit ${exitCode}: ${detail}` : `exit ${exitCode}`;
  }
  return `status ${step.status}`;
}

export function WorkflowStepAttentionPanel({ steps }: { steps: WorkflowStepAttentionItem[] }) {
  if (steps.length === 0) return null;

  return (
    <ErrorCallout padding="md" radius="md" preWrap={false}>
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
    </ErrorCallout>
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
          <div className="truncate text-sm font-medium text-text-primary" title={step.rawName}>
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
