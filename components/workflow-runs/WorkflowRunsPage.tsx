'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkflowRunsActivePanel } from '@/components/workflow-runs/WorkflowRunsActivePanel';
import { WorkflowRunsAttentionPanel } from '@/components/workflow-runs/WorkflowRunsAttentionPanel';
import {
  STATUS_FILTERS,
  type StatusFilter,
  WorkflowRunsFilterPanel,
} from '@/components/workflow-runs/WorkflowRunsFilterPanel';
import { WorkflowGraph } from '@/components/workflow-runs/WorkflowGraph';
import { WorkflowRunsEmptyState, WorkflowRunsLoadingState } from '@/components/workflow-runs/WorkflowRunsStates';
import { WorkflowStatusBadge } from '@/components/workflow-runs/workflow-run-status';
import { Button } from '@/components/ui/Button';
import { Pill, type PillTone } from '@/components/ui/Pill';
import { StandardTabs } from '@/components/ui/StandardTabs';
import { Table, type Column } from '@/components/ui/Table';

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

function outcomePillTone(tone: 'ok' | 'warn' | 'err' | 'info'): PillTone {
  switch (tone) {
    case 'ok': return 'success';
    case 'warn': return 'warning';
    case 'err': return 'error';
    case 'info': return 'accent';
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

function isRunsResponse(value: unknown): value is RunsResponse {
  if (value == null || typeof value !== 'object') return false;
  return Array.isArray((value as { runs?: unknown }).runs);
}

function workflowRunsErrorDetail(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  if (typeof body.detail === 'string' && body.detail.length > 0) return body.detail;
  return null;
}

function modeBadge(mode: RunsMeta['mode'] | undefined): { label: string; tone: PillTone; className?: string } {
  switch (mode) {
    case 'drive':
      return {
        // The orchestrator workflow drives the release pipeline.
        label: 'Release: workflow drives',
        tone: 'success',
      };
    case 'observation_only':
      return {
        // Releases create workflow_runs but the chain is still driven by hooks.
        label: 'Release: workflow observes (hooks drive)',
        tone: 'accent',
      };
    default:
      return {
        label: 'Release mode unknown',
        tone: 'neutral',
        className: 'bg-bg-tertiary text-text-tertiary',
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
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function workflowEventTime(run: WorkflowRunSummary): string | null {
  if (run.completedAt) return run.completedAt;
  if (run.startedAt) return run.startedAt;
  return run.createdAt;
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

export function WorkflowRunsPage() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<'runs' | 'graph'>('runs');
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/workflow-runs?limit=100');
        const body = (await res.json().catch((err: unknown) => {
          if (res.ok) throw err;
          return null;
        })) as unknown;
        if (!res.ok) {
          const detail = workflowRunsErrorDetail(body);
          const message = detail ?? `HTTP ${res.status}`;
          throw new Error(message);
        }
        if (!isRunsResponse(body)) {
          throw new Error('Invalid workflow runs response');
        }
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
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [reloadNonce]);

  function retryLoad() {
    setReloadNonce((current) => current + 1);
  }

  function clearFilters() {
    setNameFilter('');
    setStatusFilter('all');
  }

  if (error && !data) {
    return (
      <div className="p-4 sm:p-6">
        <WorkflowRunsEmptyState
          title="Failed to load workflow runs"
          description={error}
          meta="TamTam could not refresh workflow state from /api/workflow-runs."
          actionLabel="Retry"
          onAction={retryLoad}
        />
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
    if (!nameNeedle) return true;
    // Three summarize* calls below are non-trivial; only build the haystack
    // when there's actually a search needle to match against.
    const outcome = summarizeOutcome(r);
    const searchableText = [
      r.name,
      r.rawName,
      r.status,
      summarizeInput(r.input),
      summarizeTrigger(r.input),
      outcome.label,
    ].join(' ').toLowerCase();
    return searchableText.includes(nameNeedle);
  });
  const resultsSummary =
    filtered.length === data.runs.length
      ? `showing ${data.runs.length} recent runs`
      : `showing ${filtered.length} of ${data.runs.length} recent runs`;
  const activeRuns = filtered
    .filter((run) => run.status === 'running' || run.status === 'pending')
    .map((run) => ({
      id: run.id,
      name: run.name,
      rawName: run.rawName,
      status: run.status,
      inputLabel: summarizeInput(run.input),
      inputTitle: formatTitle(run.input),
      triggerLabel: summarizeTrigger(run.input),
      durationLabel: formatDurationCell(run, now),
      startedLabel: formatRelativeTime(run.startedAt ?? run.createdAt, now),
      startedTitle: formatTime(run.startedAt ?? run.createdAt),
    }));
  const attentionRuns = filtered
    .filter((run) => run.status === 'failed' || run.status === 'cancelled')
    .map((run) => {
      const outcome = summarizeOutcome(run);
      return {
        id: run.id,
        name: run.name,
        rawName: run.rawName,
        status: run.status,
        inputLabel: summarizeInput(run.input),
        inputTitle: formatTitle(run.input),
        triggerLabel: summarizeTrigger(run.input),
        outcomeLabel: outcome.label,
        outcomeTitle: run.error ?? outcome.label,
        finishedLabel: formatRelativeTime(run.completedAt ?? run.startedAt ?? run.createdAt, now),
        finishedTitle: formatTime(run.completedAt ?? run.startedAt ?? run.createdAt),
      };
    });
  const workflowRunColumns: Column<WorkflowRunSummary>[] = [
    {
      key: 'workflow',
      label: 'Workflow',
      cellClass: 'max-w-[260px] font-mono text-xs text-text-primary',
      cellTitle: (r) => r.rawName,
      render: (r) => (
        <div className="flex min-w-0 items-center gap-2">
          <WorkflowStatusBadge status={r.status} />
          <Link href={`/workflow-runs/${encodeURIComponent(r.id)}`} className="min-w-0 truncate hover:underline">
            {r.name}
          </Link>
        </div>
      ),
    },
    {
      key: 'input',
      label: 'Project / Args',
      cellClass: 'max-w-[220px] truncate font-mono text-xs text-text-secondary',
      cellTitle: (r) => formatTitle(r.input),
      render: (r) => summarizeInput(r.input),
    },
    {
      key: 'trigger',
      label: 'Trigger',
      title: 'Why this run was dispatched — parent job, source job, or trigger source.',
      headerClass: 'font-medium',
      cellClass: 'max-w-[240px] truncate font-mono text-xs text-text-tertiary',
      cellTitle: (r) => formatTitle(r.input),
      render: (r) => summarizeTrigger(r.input),
    },
    {
      key: 'outcome',
      label: 'Outcome',
      title: 'End status with workflow-specific detail: verdict for review, exit code for test/push/commit/fix, error tail for failed.',
      render: (r) => {
        const outcome = summarizeOutcome(r);
        return (
          <Pill tone={outcomePillTone(outcome.tone)} size="xs" title={r.error ?? ''}>
            {outcome.label}
          </Pill>
        );
      },
    },
    {
      key: 'duration',
      label: 'Duration',
      headerClass: 'text-right',
      cellClass: 'text-right font-mono text-xs text-text-secondary',
      render: (r) => formatDurationCell(r, now),
    },
    {
      key: 'last-event',
      label: 'Last event',
      title: 'Completed time for finished runs, started time for active runs.',
      cellClass: 'whitespace-nowrap text-xs text-text-secondary',
      cellTitle: (r) => formatTime(workflowEventTime(r)),
      render: (r) => {
        const eventTime = workflowEventTime(r);
        return formatRelativeTime(eventTime, now);
      },
    },
  ];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-baseline gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-text-primary">Workflow runs</h2>
        {data.meta && (() => {
          const badge = modeBadge(data.meta.mode);
          const title =
            `TAMTAM_RELEASE_WORKFLOW_DRIVE=${data.meta.releaseWorkflowDrive ? 'on (default)' : '0 (observation fallback)'}`;
          return (
            <Pill tone={badge.tone} size="xs" className={badge.className} title={title}>
              {badge.label}
            </Pill>
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
      {error ? (
        <div
          className="mb-3 flex flex-wrap items-start justify-between gap-3 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-text-primary"
          role="status"
          aria-live="polite"
        >
          <div className="min-w-0">
            <p className="font-medium text-status-warning">Refresh failed. Showing last successful results.</p>
            <p className="truncate font-mono text-xs text-text-secondary" title={error}>
              {error}
            </p>
          </div>
          <Button
            type="button"
            onClick={retryLoad}
            variant="warning"
            size="sm"
            className="px-2.5"
          >
            Retry now
          </Button>
        </div>
      ) : null}
      {view === 'graph' && <WorkflowGraph />}
      {view === 'runs' && (
        <>
          <WorkflowRunsActivePanel items={activeRuns} />
          <WorkflowRunsAttentionPanel items={attentionRuns} />
          <WorkflowRunsFilterPanel
            nameFilter={nameFilter}
            statusFilter={statusFilter}
            statusCounts={statusCounts}
            resultsSummary={resultsSummary}
            onNameFilterChange={setNameFilter}
            onStatusFilterChange={setStatusFilter}
            onClearFilters={clearFilters}
          />
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
              onAction={hasActiveFilters ? clearFilters : undefined}
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
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <WorkflowStatusBadge status={r.status} />
                      <div className="min-w-0 truncate font-mono text-xs text-text-secondary" title={formatTitle(r.input)}>
                        {inputSummary}
                      </div>
                    </div>
                  </div>
                  <Pill
                    tone={outcomePillTone(outcome.tone)}
                    size="xs"
                    className="shrink-0 max-w-[45%] truncate"
                    title={r.error ?? ''}
                  >
                    {outcome.label}
                  </Pill>
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
                    <div className="uppercase tracking-wide text-text-tertiary">Last event</div>
                    <div className="text-text-secondary" title={formatTime(workflowEventTime(r))}>
                      {formatRelativeTime(workflowEventTime(r), now)}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
        <Table
          columns={workflowRunColumns}
          rows={filtered}
          getRowKey={(r) => r.id}
          onRowClick={(r) => {
            window.location.href = `/workflow-runs/${encodeURIComponent(r.id)}`;
          }}
          className="hidden rounded-md sm:block"
        />
        </>
      )}
      </>
      )}
    </div>
  );
}
