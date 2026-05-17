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

/** "Why did this run?" — extracted from input args. For release/phase
 *  workflows the first arg is usually projectName; subsequent args carry
 *  sourceJobId / parentJobId / agentName. */
function summarizeTrigger(input: unknown): string {
  if (!Array.isArray(input)) return '—';
  // Most workflows take (projectName, ...rest). Skip the project name (it
  // gets its own column) and surface the *why* — agent, parent job, etc.
  for (let i = 1; i < input.length; i++) {
    const v = input[i];
    if (v == null) continue;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const reason = pickString(o, ['triggeredBy', 'reason', 'sourceJobId', 'parentJobId', 'agentName']);
      if (reason) return reason;
      const queue = o.queueIfBlocked === true ? 'queue-if-blocked' : null;
      if (queue) return queue;
    }
  }
  return '—';
}

/** "What's the end status?" — combines status with the most useful detail
 *  the workflow output carries: review verdict, exit code, error tail. */
function summarizeOutcome(run: WorkflowRunSummary): { label: string; tone: 'ok' | 'warn' | 'err' | 'info' } {
  if (run.status === 'running' || run.status === 'pending') {
    return { label: run.status, tone: 'info' };
  }
  if (run.status === 'cancelled') return { label: 'cancelled', tone: 'err' };
  if (run.status === 'failed') {
    const tail = run.error ? run.error.split('\n')[0].slice(0, 60) : 'failed';
    return { label: tail, tone: 'err' };
  }
  // Completed: dig into output for verdict / exit code.
  const out = run.output;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string, unknown>;
    const verdict = pickString(o, ['verdict']);
    if (verdict) {
      const tone = verdict === 'LGTM' ? 'ok' : verdict === 'DO NOT SHIP' ? 'err' : 'warn';
      return { label: verdict, tone };
    }
    if (typeof o.exitCode === 'number') {
      return o.exitCode === 0
        ? { label: 'exit 0', tone: 'ok' }
        : { label: `exit ${o.exitCode}`, tone: 'err' };
    }
    if (typeof o.dispatched === 'boolean') {
      return { label: o.dispatched ? 'dispatched' : 'skipped', tone: o.dispatched ? 'ok' : 'info' };
    }
    if (typeof o.ok === 'boolean') {
      return o.ok ? { label: 'ok', tone: 'ok' } : { label: 'not ok', tone: 'warn' };
    }
  }
  return { label: 'completed', tone: 'ok' };
}

function outcomeBadge(tone: 'ok' | 'warn' | 'err' | 'info'): string {
  switch (tone) {
    case 'ok':   return 'bg-status-success/15 text-status-success border-status-success/30';
    case 'warn': return 'bg-status-warning/15 text-status-warning border-status-warning/30';
    case 'err':  return 'bg-status-error/15 text-status-error border-status-error/30';
    case 'info': return 'bg-accent/15 text-accent border-accent/30';
  }
}

interface RunsMeta {
  workflowEnabled: boolean;
  releaseWorkflow: boolean;
  releaseWorkflowDrive: boolean;
  mode: 'observation_only' | 'drive';
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
            `TAMTAM_RELEASE_WORKFLOW_DRIVE=${data.meta.releaseWorkflowDrive ? 'on (default)' : '0 (observation fallback)'}`;
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
              <th className="text-left px-3 py-2 font-medium">Project / Args</th>
              <th className="text-left px-3 py-2 font-medium" title="Why this run was dispatched — parent job, source job, or trigger source.">Trigger</th>
              <th className="text-left px-3 py-2 font-medium" title="End status with workflow-specific detail: verdict for review, exit code for test/push/commit/fix, error tail for failed.">Outcome</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
              <th className="text-left px-3 py-2 font-medium">Started</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const outcome = summarizeOutcome(r);
              return (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-bg-tertiary/40 cursor-pointer"
                  onClick={() => { window.location.href = `/workflow-runs/${encodeURIComponent(r.id)}`; }}
                >
                  <td className="px-3 py-2 font-mono text-xs text-text-primary truncate max-w-[260px]" title={r.rawName}>
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
                  <td
                    className="px-3 py-2 font-mono text-xs text-text-tertiary truncate max-w-[240px]"
                    title={typeof r.input === 'object' ? JSON.stringify(r.input) : String(r.input ?? '')}
                  >
                    {summarizeTrigger(r.input)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded border text-xs ${outcomeBadge(outcome.tone)}`} title={r.error ?? ''}>
                      {outcome.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                    {formatDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary whitespace-nowrap">
                    {formatTime(r.startedAt ?? r.createdAt)}
                  </td>
                </tr>
              );
            })}
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
