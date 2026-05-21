'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkflowRunDetailLoadingState, WorkflowRunsEmptyState } from '@/components/workflow-runs/WorkflowRunsStates';
import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';

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
    output: unknown;
    error: string | null;
  };
  steps: Step[];
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
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
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

export function WorkflowRunDetail({ runId }: { runId: string }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? body.detail ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as RunDetail;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [runId]);

  if (notFound) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Link href="/workflow-runs" className="text-accent text-sm hover:underline">← Back to workflow runs</Link>
        <WorkflowRunsEmptyState
          title="Workflow run not found"
          description="The run may have been pruned, or the URL no longer points to an existing workflow record."
          actionLabel="Back to workflow runs"
          actionHref="/workflow-runs"
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Link href="/workflow-runs" className="text-accent text-sm hover:underline">← Back to workflow runs</Link>
        <div className="mt-4 text-status-error">Failed to load: {error}</div>
      </div>
    );
  }
  if (!data) return <WorkflowRunDetailLoadingState />;

  const now = Date.now();
  const stepStatusCounts = countStepStatuses(data.steps);
  const runDuration = formatDurationCell(data.run.status, data.run.durationMs, data.run.startedAt, now);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <Link href="/workflow-runs" className="text-accent text-sm hover:underline">← Back to workflow runs</Link>
      </div>

      <div className="border border-border rounded-md p-4 bg-bg-secondary">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="text-lg font-semibold text-text-primary font-mono" title={data.run.rawName}>
            {data.run.name}
          </h2>
          <WorkflowStatusBadge status={data.run.status} />
          <span className="text-xs text-text-tertiary font-mono">{data.run.id}</span>
        </div>
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
          <div className="mt-3 p-2 rounded border border-status-error/30 bg-status-error/10 text-status-error text-xs whitespace-pre-wrap">
            {data.run.error}
          </div>
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
            <div className="space-y-2 sm:hidden">
              {data.steps.map((s) => (
                <div key={s.stepId} className="rounded-md border border-border bg-bg-primary p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-text-primary" title={s.rawName}>
                        {s.name}
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
                      <div className="uppercase tracking-wide text-text-tertiary">Completed</div>
                      <div className="truncate text-text-secondary" title={formatAbsoluteTime(s.completedAt)}>
                        {formatRelativeTime(s.completedAt, now)}
                      </div>
                    </div>
                  </div>
                  {s.error && (
                    <div className="mt-3 rounded border border-status-error/30 bg-status-error/10 p-2 text-xs whitespace-pre-wrap text-status-error">
                      {s.error}
                    </div>
                  )}
                  {s.output != null && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-text-tertiary">Output</summary>
                      <pre className="mt-1 overflow-x-auto rounded border border-border bg-bg-tertiary p-2 text-text-primary">
                        {JSON.stringify(s.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
            <div className="hidden overflow-hidden rounded-md border border-border sm:block">
              <table className="w-full text-sm">
                <thead className="bg-bg-secondary text-text-secondary text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Step</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Attempt</th>
                    <th className="text-right px-3 py-2 font-medium">Duration</th>
                    <th className="text-left px-3 py-2 font-medium">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.steps.map((s) => (
                    <tr key={s.stepId} className="border-t border-border align-top">
                      <td className="px-3 py-2 font-mono text-xs text-text-primary" title={s.rawName}>
                        {s.name}
                        {s.error && (
                          <div className="mt-1 p-2 rounded border border-status-error/30 bg-status-error/10 text-status-error text-xs whitespace-pre-wrap">
                            {s.error}
                          </div>
                        )}
                        {s.output != null && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-text-tertiary">Output</summary>
                            <pre className="mt-1 p-2 rounded bg-bg-tertiary border border-border overflow-x-auto text-text-primary">
                              {JSON.stringify(s.output, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <WorkflowStatusBadge status={s.status} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">{s.attempt}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                        {formatDurationCell(s.status, s.durationMs, s.startedAt, now)}
                      </td>
                      <td
                        className="whitespace-nowrap px-3 py-2 text-xs text-text-secondary"
                        title={formatAbsoluteTime(s.completedAt)}
                      >
                        {formatRelativeTime(s.completedAt, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
