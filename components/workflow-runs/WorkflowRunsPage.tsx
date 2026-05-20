'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkflowGraph } from '@/components/workflow-runs/WorkflowGraph';
import { WorkflowRunsEmptyState, WorkflowRunsLoadingState } from '@/components/workflow-runs/WorkflowRunsStates';
import { StandardTabs } from '@/components/ui/StandardTabs';

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

function formatDurationCell(run: WorkflowRunSummary, now: number): string {
  if (run.durationMs != null) return formatDuration(run.durationMs);
  if ((run.status === 'running' || run.status === 'pending') && run.startedAt) {
    const startedAt = Date.parse(run.startedAt);
    if (Number.isFinite(startedAt)) {
      return formatDuration(Math.max(0, now - startedAt));
    }
  }
  return '—';
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
  return formatTime(iso);
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatTitle(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}


const STATUS_FILTERS = ['all', 'completed', 'running', 'pending', 'failed', 'cancelled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export function WorkflowRunsPage() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<'runs' | 'graph'>('runs');

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
    return <WorkflowRunsLoadingState />;
  }
  if (data.reason) {
    return (
      <div className="p-4 sm:p-6">
        <WorkflowRunsEmptyState
          title="Workflow runs unavailable"
          description={data.reason}
        />
      </div>
    );
  }

  const nameNeedle = nameFilter.trim().toLowerCase();
  const hasActiveFilters = nameNeedle.length > 0 || statusFilter !== 'all';
  const now = Date.now();
  const statusCounts = data.runs.reduce<Record<StatusFilter, number>>(
    (counts, run) => {
      counts.all += 1;
      const status = STATUS_FILTERS.find((s) => s !== 'all' && s === run.status);
      if (status) counts[status] += 1;
      return counts;
    },
    {
      all: 0,
      completed: 0,
      running: 0,
      pending: 0,
      failed: 0,
      cancelled: 0,
    },
  );
  const filtered = data.runs.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    const outcome = summarizeOutcome(r);
    const searchableText = [
      r.name,
      r.rawName,
      r.status,
      summarizeInput(r.input),
      summarizeTrigger(r.input),
      outcome.label,
    ].join(' ').toLowerCase();
    if (nameNeedle && !searchableText.includes(nameNeedle)) {
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
        <StandardTabs
          items={[
            { id: 'runs', label: 'Runs' },
            { id: 'graph', label: 'Graph' },
          ]}
          activeTab={view}
          ariaLabel="Workflow run views"
          className="ml-auto mb-0"
          onChange={setView}
        />
      </div>
      {view === 'graph' && <WorkflowGraph />}
      {view === 'runs' && (
      <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter workflow, project, trigger, outcome…"
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          className="focus-ring w-full rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none sm:w-72"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              aria-pressed={statusFilter === s}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                statusFilter === s
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              <span>{s}</span>
              <span className="font-mono tabular-nums text-text-tertiary">{statusCounts[s]}</span>
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <WorkflowRunsEmptyState
          title={data.runs.length === 0 ? 'No workflow runs yet' : 'No runs match current filters'}
          description={
            data.runs.length === 0
              ? 'Runs appear here after a workflow starts from a release, scheduler, or another background trigger.'
              : 'Adjust the name or status filter to bring workflow activity back into view.'
          }
          meta={
            data.runs.length === 0
              ? 'refreshes every 5s'
              : `status=${statusFilter} · query=${nameFilter.trim() || '—'}`
          }
          actionLabel={hasActiveFilters ? 'Clear filters' : undefined}
          onAction={hasActiveFilters ? () => {
            setNameFilter('');
            setStatusFilter('all');
          } : undefined}
        />
      ) : (
        <>
        <div className="overflow-hidden rounded-md border border-border sm:hidden">
          {filtered.map((r) => {
            const outcome = summarizeOutcome(r);
            const inputSummary = summarizeInput(r.input);
            const triggerSummary = summarizeTrigger(r.input);
            return (
              <Link
                key={r.id}
                href={`/workflow-runs/${encodeURIComponent(r.id)}`}
                className="block border-b border-border bg-bg-primary px-3 py-3 transition-colors last:border-b-0 hover:bg-bg-tertiary/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-text-primary" title={r.rawName}>
                      {r.name}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-text-secondary" title={formatTitle(r.input)}>
                      {inputSummary}
                    </div>
                  </div>
                  <span className={`shrink-0 max-w-[45%] truncate rounded border px-2 py-0.5 text-xs ${outcomeBadge(outcome.tone)}`} title={r.error ?? ''}>
                    {outcome.label}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="uppercase tracking-wide text-text-tertiary">Trigger</div>
                    <div className="truncate font-mono text-text-secondary" title={formatTitle(r.input)}>
                      {triggerSummary}
                    </div>
                  </div>
                  <div>
                    <div className="uppercase tracking-wide text-text-tertiary">Duration</div>
                    <div className="font-mono text-text-secondary tabular-nums">{formatDurationCell(r, now)}</div>
                  </div>
                  <div>
                    <div className="uppercase tracking-wide text-text-tertiary">Started</div>
                    <div className="text-text-secondary" title={formatTime(r.startedAt ?? r.createdAt)}>
                      {formatRelativeTime(r.startedAt ?? r.createdAt, now)}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
        <div className="hidden overflow-hidden rounded-md border border-border sm:block">
          <table className="w-full text-sm">
            <thead className="bg-bg-secondary text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Workflow</th>
                <th className="px-3 py-2 text-left font-medium">Project / Args</th>
                <th className="px-3 py-2 text-left font-medium" title="Why this run was dispatched — parent job, source job, or trigger source.">Trigger</th>
                <th className="px-3 py-2 text-left font-medium" title="End status with workflow-specific detail: verdict for review, exit code for test/push/commit/fix, error tail for failed.">Outcome</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-left font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const outcome = summarizeOutcome(r);
                return (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t border-border hover:bg-bg-tertiary/40"
                    onClick={() => { window.location.href = `/workflow-runs/${encodeURIComponent(r.id)}`; }}
                  >
                    <td className="max-w-[260px] truncate px-3 py-2 font-mono text-xs text-text-primary" title={r.rawName}>
                      <Link href={`/workflow-runs/${encodeURIComponent(r.id)}`} className="hover:underline">
                        {r.name}
                      </Link>
                    </td>
                    <td
                      className="max-w-[220px] truncate px-3 py-2 font-mono text-xs text-text-secondary"
                      title={formatTitle(r.input)}
                    >
                      {summarizeInput(r.input)}
                    </td>
                    <td
                      className="max-w-[240px] truncate px-3 py-2 font-mono text-xs text-text-tertiary"
                      title={formatTitle(r.input)}
                    >
                      {summarizeTrigger(r.input)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${outcomeBadge(outcome.tone)}`} title={r.error ?? ''}>
                        {outcome.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-text-secondary">
                      {formatDurationCell(r, now)}
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-2 text-xs text-text-secondary"
                      title={formatTime(r.startedAt ?? r.createdAt)}
                    >
                      {formatRelativeTime(r.startedAt ?? r.createdAt, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      </>
      )}
    </div>
  );
}
