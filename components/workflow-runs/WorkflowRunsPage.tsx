'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface WorkflowRunSummary {
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
}

// Pull a human-readable first-line summary out of a workflow input.
// Workflow inputs are always devalue-encoded; once decoded they're usually
// `[firstArg, secondArg?]`. The first arg is either a primitive (project
// name) or an object (params). Look for the most operator-useful key.
function summarizeInput(input: unknown): string {
  if (input == null) return '—';
  if (Array.isArray(input)) {
    if (input.length === 0) return '—';
    const head = summarizeArg(input[0]);
    return input.length > 1 ? `${head} (+${input.length - 1})` : head;
  }
  return summarizeArg(input);
}

function summarizeArg(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    // Prefer the most identifying field. project/projectName is what most
    // operators look for first; agentName/jobId help narrow within a project.
    const obj = value as Record<string, unknown>;
    const project = pickString(obj, ['project', 'projectName']);
    const agent = pickString(obj, ['agentName', 'agentId']);
    const job = pickString(obj, ['jobId']);
    if (project && agent) return `${project} · ${agent}`;
    if (project) return project;
    if (agent) return agent;
    if (job) return job;
    return '[object]';
  }
  return `[${typeof value}]`;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

interface RunsMeta {
  workflowEnabled: boolean;
  releaseWorkflow: boolean;
  releaseWorkflowDrive: boolean;
  mode: 'disabled' | 'observation_only' | 'drive';
}

interface RunsResponse {
  runs: WorkflowRunSummary[];
  reason?: string;
  meta?: RunsMeta;
}

function modeBadge(mode: RunsMeta['mode'] | undefined): { label: string; className: string } {
  switch (mode) {
    case 'drive':
      return {
        // The orchestrator workflow drives the release pipeline.
        label: 'Release: workflow drives',
        className: 'bg-status-success/15 text-status-success border-status-success/30',
      };
    case 'observation_only':
      return {
        // Releases create workflow_runs but the chain is still driven by hooks.
        label: 'Release: workflow observes (hooks drive)',
        className: 'bg-accent/15 text-accent border-accent/30',
      };
    case 'disabled':
      return {
        // Release path is not wrapped in a workflow at all.
        // Agent runs may still use workflows independently.
        label: 'Release: hooks drive (default)',
        className: 'bg-bg-tertiary text-text-tertiary border-border',
      };
    default:
      return {
        label: 'Release mode unknown',
        className: 'bg-bg-tertiary text-text-tertiary border-border',
      };
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

const STATUS_FILTERS = ['all', 'completed', 'running', 'pending', 'failed', 'cancelled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export function WorkflowRunsPage() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/workflow-runs?limit=100');
        const body = (await res.json()) as RunsResponse;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <div className="text-status-error">Failed to load workflow runs: {error}</div>
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-text-tertiary">Loading workflow runs…</div>;
  }
  if (data.reason) {
    return (
      <div className="p-6">
        <div className="text-text-tertiary">{data.reason}</div>
      </div>
    );
  }

  const nameNeedle = nameFilter.trim().toLowerCase();
  const filtered = data.runs.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (nameNeedle && !r.name.toLowerCase().includes(nameNeedle) && !r.rawName.toLowerCase().includes(nameNeedle)) {
      return false;
    }
    return true;
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-baseline gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-text-primary">Workflow runs</h2>
        {data.meta && (() => {
          const badge = modeBadge(data.meta.mode);
          const title =
            `TAMTAM_RELEASE_WORKFLOW=${data.meta.releaseWorkflow ? '1' : 'unset'}, ` +
            `TAMTAM_RELEASE_WORKFLOW_DRIVE=${data.meta.releaseWorkflowDrive ? '1' : 'unset'}`;
          return (
            <span className={`inline-block px-2 py-0.5 rounded border text-xs ${badge.className}`} title={title}>
              {badge.label}
            </span>
          );
        })()}
        <span className="text-xs text-text-tertiary">
          {filtered.length === data.runs.length
            ? `${data.runs.length} recent · refresh every 5s`
            : `${filtered.length} of ${data.runs.length} recent · refresh every 5s`}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by workflow name…"
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-border bg-bg-secondary text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent w-full sm:w-72"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                statusFilter === s
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-secondary text-text-secondary text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Workflow</th>
              <th className="text-left px-3 py-2 font-medium">Args</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
              <th className="text-left px-3 py-2 font-medium">Completed</th>
              <th className="text-left px-3 py-2 font-medium">Run ID</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                className="border-t border-border hover:bg-bg-tertiary/40 cursor-pointer"
                onClick={() => { window.location.href = `/workflow-runs/${encodeURIComponent(r.id)}`; }}
              >
                <td className="px-3 py-2 font-mono text-xs text-text-primary truncate max-w-[280px]" title={r.rawName}>
                  <Link href={`/workflow-runs/${encodeURIComponent(r.id)}`} className="hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td
                  className="px-3 py-2 font-mono text-xs text-text-secondary truncate max-w-[220px]"
                  title={typeof r.input === 'object' ? JSON.stringify(r.input) : String(r.input ?? '')}
                >
                  {summarizeInput(r.input)}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded border text-xs ${statusBadge(r.status)}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                  {formatDuration(r.durationMs)}
                </td>
                <td className="px-3 py-2 text-xs text-text-secondary whitespace-nowrap">
                  {formatTime(r.completedAt)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-tertiary truncate max-w-[200px]" title={r.id}>
                  {r.id}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-text-tertiary">
                  {data.runs.length === 0 ? 'No workflow runs yet' : 'No runs match current filters'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
