'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { WorkflowRunDetailLoadingState, WorkflowRunsEmptyState } from '@/components/workflow-runs/WorkflowRunsStates';
import {
  WorkflowStepAttentionPanel,
  workflowStepAnchorId,
  workflowStepNeedsAttention,
} from '@/components/workflow-runs/WorkflowStepAttentionPanel';
import { WorkflowStatusBadge, workflowStatusPresentation } from '@/components/workflow-runs/workflow-run-status';
import { humanizeWorkflowLabel, humanizeEmbeddedNames } from '@/components/workflow-runs/humanize';
import { summarizeInput, summarizeTrigger } from '@/components/workflow-runs/summarize';
import { buttonVariants } from '@/components/ui/Button';
import { ErrorState } from '@/components/ErrorState';
import { ErrorCallout } from '@/components/ui/ErrorCallout';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { Table, type Column } from '@/components/ui/Table';

interface Step {
  stepId: string;
  name: string;
  rawName: string;
  status: string;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
}

interface RunDetail {
  run: {
    id: string;
    name: string;
    rawName: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    input: unknown;
    output: unknown;
    error: string | null;
  };
  steps: Step[];
}

function isTerminalWorkflowStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

function formatDurationCell(
  status: string,
  durationMs: number | null,
  startedAt: string | null,
  now: number,
): string {
  if (durationMs != null) return formatDuration(durationMs);
  if ((status === 'running' || status === 'pending') && startedAt) {
    const startedAtMs = Date.parse(startedAt);
    if (Number.isFinite(startedAtMs)) {
      return formatDuration(Math.max(0, now - startedAtMs));
    }
  }
  return '—';
}

function formatAbsoluteTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return '—';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 60_000) return 'just now';
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatAbsoluteTime(iso);
}

const STEP_STATUS_ORDER = ['failed', 'cancelled', 'running', 'pending', 'completed'] as const;

function countStepStatuses(steps: Step[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  }

  const ordered = STEP_STATUS_ORDER
    .filter((status) => counts.has(status))
    .map((status) => ({ status, count: counts.get(status) ?? 0 }));

  const knownStatuses = new Set<string>(STEP_STATUS_ORDER);
  const remaining = Array.from(counts.entries())
    .filter(([status]) => !knownStatuses.has(status))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => ({ status, count }));

  return [...ordered, ...remaining];
}

function WorkflowStepTrace({ steps, now }: { steps: Step[]; now: number }) {
  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-border bg-bg-secondary">
      <ol className="flex min-w-max items-stretch divide-x divide-border">
        {steps.map((step, index) => {
          const presentation = workflowStatusPresentation(step.status);
          const timing = formatDurationCell(step.status, step.durationMs, step.startedAt, now);
          const completedLabel = formatRelativeTime(step.completedAt ?? step.startedAt, now);

          return (
            <li key={step.stepId} className="w-44 px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${presentation.className}`}
                  aria-label={`step ${index + 1} status ${step.status}`}
                  title={`status: ${step.status}`}
                >
                  {presentation.spin ? (
                    <Spinner size="sm" shrink aria-hidden="true" />
                  ) : (
                    <span className="leading-none" aria-hidden="true">
                      {presentation.glyph}
                    </span>
                  )}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary" title={step.rawName}>
                    {index + 1}. {humanizeWorkflowLabel(step.name)}
                  </div>
                  <div className="truncate font-mono text-[11px] tabular-nums text-text-tertiary">
                    attempt {step.attempt} · {timing}
                  </div>
                </div>
              </div>
              <div
                className="mt-2 truncate text-[11px] text-text-secondary"
                title={formatAbsoluteTime(step.completedAt ?? step.startedAt)}
              >
                {completedLabel}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepDiagnostics({
  error,
  output,
  className = 'mt-3',
}: {
  error: string | null;
  output: unknown;
  className?: string;
}) {
  if (error == null && output == null) {
    return null;
  }

  return (
    <details className={`${className} text-xs`}>
      <summary className="cursor-pointer text-text-tertiary">
        details
        {error != null ? ' · error' : ''}
        {output != null ? ' · output' : ''}
      </summary>
      <div className="mt-2 space-y-2">
        {error != null ? (
          <ErrorCallout>{humanizeEmbeddedNames(error)}</ErrorCallout>
        ) : null}
        {output != null ? (
          <pre className="overflow-x-auto rounded border border-border bg-bg-tertiary p-2 text-text-primary">
            {JSON.stringify(output, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

export function WorkflowRunDetail({ runId }: { runId: string }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const latestRunStatusRef = useRef<string | null>(null);
  const hasLoadedDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null;

    setData(null);
    setError(null);
    setNotFound(false);
    setLastLoadedAt(null);
    latestRunStatusRef.current = null;
    hasLoadedDataRef.current = false;

    function scheduleRefresh() {
      refreshTimeout = setTimeout(load, 5000);
    }

    function shouldRetryAfterFailure() {
      return latestRunStatusRef.current == null || !isTerminalWorkflowStatus(latestRunStatusRef.current);
    }

    async function load() {
      try {
        const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`);
        if (res.status === 404) {
          if (!cancelled) {
            if (hasLoadedDataRef.current) {
              setNotFound(false);
              setError('workflow run not found');
              if (shouldRetryAfterFailure()) {
                scheduleRefresh();
              }
            } else {
              setNotFound(true);
              setData(null);
              setError(null);
            }
          }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) {
            setNotFound(false);
            setError(body.error ?? body.detail ?? `HTTP ${res.status}`);
            if (shouldRetryAfterFailure()) {
              scheduleRefresh();
            }
          }
          return;
        }
        const body = (await res.json()) as RunDetail;
        if (!cancelled) {
          setNotFound(false);
          setData(body);
          setError(null);
          setLastLoadedAt(Date.now());
          latestRunStatusRef.current = body.run.status;
          hasLoadedDataRef.current = true;
          if (!isTerminalWorkflowStatus(body.run.status)) {
            scheduleRefresh();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          if (shouldRetryAfterFailure()) {
            scheduleRefresh();
          }
        }
      }
    }
    load();
    return () => {
      cancelled = true;
      if (refreshTimeout != null) {
        clearTimeout(refreshTimeout);
      }
    };
  }, [runId, reloadNonce]);

  if (notFound) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Link href="/workflow-runs" className={buttonVariants({ variant: 'link' })}>← Back to workflow runs</Link>
        <WorkflowRunsEmptyState
          title="Workflow run not found"
          description="The run may have been pruned, or the URL no longer points to an existing workflow record."
          actionLabel="Back to workflow runs"
          actionHref="/workflow-runs"
        />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="p-6">
        <Link href="/workflow-runs" className={buttonVariants({ variant: 'link' })}>← Back to workflow runs</Link>
        <ErrorState
          message={`Failed to load workflow run: ${error}`}
          hint="Retrying automatically every few seconds."
          onRetry={() => setReloadNonce((n) => n + 1)}
        />
      </div>
    );
  }
  if (!data) return <WorkflowRunDetailLoadingState />;

  const now = Date.now();
  const isLiveRun = !isTerminalWorkflowStatus(data.run.status);
  const runLabel = humanizeWorkflowLabel(data.run.name);
  const projectLabel = summarizeInput(data.run.input);
  const triggerLabel = summarizeTrigger(data.run.input);
  const stepStatusCounts = countStepStatuses(data.steps);
  const runDuration = formatDurationCell(data.run.status, data.run.durationMs, data.run.startedAt, now);
  const attentionSteps = data.steps
    .filter(workflowStepNeedsAttention)
    .map((step) => ({
      stepId: step.stepId,
      name: humanizeWorkflowLabel(step.name),
      rawName: step.rawName,
      status: step.status,
      attempt: step.attempt,
      durationLabel: formatDurationCell(step.status, step.durationMs, step.startedAt, now),
      completedLabel: formatRelativeTime(step.completedAt ?? step.startedAt, now),
      error: step.error,
    }));
  const stepColumns: Column<Step>[] = [
    {
      key: 'step',
      label: 'Step',
      render: (step) => (
        <div className="text-xs text-text-primary">
          <div className="font-medium">{humanizeWorkflowLabel(step.name)}</div>
          <StepDiagnostics error={step.error} output={step.output} className="mt-1" />
        </div>
      ),
      cellTitle: (step) => step.rawName,
    },
    {
      key: 'status',
      label: 'Status',
      render: (step) => <WorkflowStatusBadge status={step.status} />,
    },
    {
      key: 'attempt',
      label: 'Attempt',
      render: (step) => step.attempt,
      headerClass: 'text-right',
      cellClass: 'text-right font-mono text-xs text-text-secondary',
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (step) => formatDurationCell(step.status, step.durationMs, step.startedAt, now),
      headerClass: 'text-right',
      cellClass: 'text-right font-mono text-xs text-text-secondary',
    },
    {
      key: 'last-event',
      label: 'Last event',
      render: (step) => formatRelativeTime(step.completedAt ?? step.startedAt, now),
      cellTitle: (step) => formatAbsoluteTime(step.completedAt ?? step.startedAt),
      cellClass: 'whitespace-nowrap text-xs text-text-secondary',
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <Link href="/workflow-runs" className={buttonVariants({ variant: 'link' })}>← Back to workflow runs</Link>
      </div>

      <div className="border border-border rounded-md p-4 bg-bg-secondary">
        <div className="flex flex-wrap items-baseline gap-3 mb-1">
          <h2 className="text-lg font-semibold text-text-primary" title={data.run.rawName}>
            {runLabel}
          </h2>
          <WorkflowStatusBadge status={data.run.status} />
          <Pill size="xs" tone="neutral" className="bg-bg-tertiary px-1.5 font-mono text-[11px] font-normal">
            {isLiveRun ? 'live · refreshes every 5s' : 'final snapshot'}
          </Pill>
          {lastLoadedAt != null ? (
            <span className="text-[11px] text-text-tertiary" title={new Date(lastLoadedAt).toLocaleString()}>
              refreshed {new Date(lastLoadedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        <p className="mb-3 text-sm text-text-secondary">
          {projectLabel !== '—' ? (
            <>
              Project <span className="font-medium text-text-primary">{projectLabel}</span>
            </>
          ) : (
            'No project context recorded'
          )}
          {triggerLabel !== '—' ? <> · triggered by {triggerLabel}</> : null}
          <span className="ml-2 font-mono text-[11px] text-text-tertiary">{data.run.id}</span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Created</div>
            <div className="mt-0.5 text-text-primary" title={formatAbsoluteTime(data.run.createdAt)}>
              {formatRelativeTime(data.run.createdAt, now)}
            </div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Started</div>
            <div className="mt-0.5 text-text-primary" title={formatAbsoluteTime(data.run.startedAt)}>
              {formatRelativeTime(data.run.startedAt, now)}
            </div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Completed</div>
            <div className="mt-0.5 text-text-primary" title={formatAbsoluteTime(data.run.completedAt)}>
              {formatRelativeTime(data.run.completedAt, now)}
            </div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Duration</div>
            <div className="mt-0.5 font-mono text-text-primary">{runDuration}</div>
          </div>
        </div>
        {data.run.error != null && (
          <ErrorCallout className="mt-3 text-xs">{humanizeEmbeddedNames(data.run.error)}</ErrorCallout>
        )}
        {data.run.output != null && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-text-secondary">Output</summary>
            <pre className="mt-1 p-2 rounded bg-bg-tertiary border border-border overflow-x-auto text-text-primary">
              {JSON.stringify(data.run.output, null, 2)}
            </pre>
          </details>
        )}
      </div>

      {error ? (
        <ErrorCallout tone="warning" radius="md" className="px-3 py-2 text-xs" preWrap={false}>
          Failed to refresh: {error}
        </ErrorCallout>
      ) : null}

      <WorkflowStepAttentionPanel steps={attentionSteps} />

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium uppercase tracking-wide text-text-secondary">
            Steps <span className="font-mono tabular-nums">({data.steps.length})</span>
          </h3>
          {stepStatusCounts.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {stepStatusCounts.map(({ status, count }) => (
                <WorkflowStatusBadge
                  key={status}
                  status={status}
                  suffix={<span className="font-mono tabular-nums">{count}</span>}
                />
              ))}
            </div>
          ) : null}
        </div>
        {data.steps.length === 0 ? (
          <WorkflowRunsEmptyState
            title="No steps recorded"
            description="This workflow completed without persisting step detail, or step tracing has not been emitted yet."
          />
        ) : (
          <>
            <div className="hidden sm:block">
              <WorkflowStepTrace steps={data.steps} now={now} />
            </div>
            <div className="space-y-2 sm:hidden">
              {data.steps.map((s) => (
                <div
                  key={s.stepId}
                  id={workflowStepAnchorId(s.stepId, 'mobile')}
                  className={`scroll-mt-4 rounded-md border p-3 ${
                    workflowStepNeedsAttention(s)
                      ? 'border-status-error/30 bg-status-error/10'
                      : 'border-border bg-bg-primary'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary" title={s.rawName}>
                        {humanizeWorkflowLabel(s.name)}
                      </div>
                      <div className="mt-1 font-mono text-xs tabular-nums text-text-secondary">
                        attempt {s.attempt} · {formatDurationCell(s.status, s.durationMs, s.startedAt, now)}
                      </div>
                    </div>
                    <WorkflowStatusBadge status={s.status} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="uppercase tracking-wide text-text-tertiary">Started</div>
                      <div className="truncate text-text-secondary" title={formatAbsoluteTime(s.startedAt)}>
                        {formatRelativeTime(s.startedAt, now)}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="uppercase tracking-wide text-text-tertiary">Last event</div>
                      <div className="truncate text-text-secondary" title={formatAbsoluteTime(s.completedAt ?? s.startedAt)}>
                        {formatRelativeTime(s.completedAt ?? s.startedAt, now)}
                      </div>
                    </div>
                  </div>
                  <StepDiagnostics error={s.error} output={s.output} />
                </div>
              ))}
            </div>
            <Table
              columns={stepColumns}
              rows={data.steps}
              getRowKey={(step) => step.stepId}
              rowId={(step) => workflowStepAnchorId(step.stepId, 'desktop')}
              rowClassName={(step) =>
                `hidden scroll-mt-4 align-top sm:table-row ${
                  workflowStepNeedsAttention(step)
                    ? 'border-status-error/30 bg-status-error/10'
                    : 'border-border'
                }`
              }
              className="hidden sm:block"
            />
          </>
        )}
      </div>
    </div>
  );
}
