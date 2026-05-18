'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkflowRunDetailLoadingState, WorkflowRunsEmptyState } from '@/components/workflow-runs/WorkflowRunsStates';

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

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-status-success/15 text-status-success border-status-success/30';
    case 'failed':
    case 'cancelled':
      return 'bg-status-error/15 text-status-error border-status-error/30';
    case 'running':
    case 'pending':
      return 'bg-accent/15 text-accent border-accent/30';
    default:
      return 'bg-bg-tertiary text-text-tertiary border-border';
  }
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
          <span className={`inline-block px-2 py-0.5 rounded border text-xs ${statusBadge(data.run.status)}`}>
            {data.run.status}
          </span>
          <span className="text-xs text-text-tertiary font-mono">{data.run.id}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Created</div>
            <div className="text-text-primary mt-0.5">{formatTime(data.run.createdAt)}</div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Started</div>
            <div className="text-text-primary mt-0.5">{formatTime(data.run.startedAt)}</div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Completed</div>
            <div className="text-text-primary mt-0.5">{formatTime(data.run.completedAt)}</div>
          </div>
          <div>
            <div className="text-text-tertiary uppercase tracking-wide">Duration</div>
            <div className="text-text-primary mt-0.5 font-mono">{formatDuration(data.run.durationMs)}</div>
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
        <h3 className="text-sm font-medium text-text-secondary mb-2 uppercase tracking-wide">
          Steps ({data.steps.length})
        </h3>
        <div className="border border-border rounded-md overflow-hidden">
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
                    <span className={`inline-block px-2 py-0.5 rounded border text-xs ${statusBadge(s.status)}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">{s.attempt}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                    {formatDuration(s.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary whitespace-nowrap">
                    {formatTime(s.completedAt)}
                  </td>
                </tr>
              ))}
              {data.steps.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-5">
                    <WorkflowRunsEmptyState
                      title="No steps recorded"
                      description="This workflow completed without persisting step detail, or step tracing has not been emitted yet."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
