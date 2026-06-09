// Operator-facing summaries derived from a workflow run's decoded input/output.
//
// Workflow inputs are devalue-encoded; once decoded they're usually
// `[firstArg, secondArg?]`. The first arg is either a primitive (project
// name) or an object (params). These helpers pull out the bits an operator
// scans for — which project, why it ran, how it ended — without making them
// read raw JSON. Shared by the list and detail views.

import type { PillTone } from '@/components/ui/Pill';
import { humanizeEmbeddedNames } from '@/components/workflow-runs/humanize';
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes';

export type OutcomeTone = 'ok' | 'warn' | 'err' | 'info';

export interface OutcomeInput {
  status: string;
  error: string | null;
  output?: unknown;
}

function extractDirectWorkflowExitCode(output: unknown): number | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;
  const directExitCode = obj.exitCode;
  return typeof directExitCode === 'number' ? directExitCode : null;
}

function extractWaitedJobExitCode(output: unknown): number | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;
  const waited = obj.waited;
  if (!waited || typeof waited !== 'object' || Array.isArray(waited)) return null;
  const waitedJob = (waited as Record<string, unknown>).job;
  if (!waitedJob || typeof waitedJob !== 'object' || Array.isArray(waitedJob)) return null;
  const waitedExitCode = (waitedJob as Record<string, unknown>).exitCode;
  return typeof waitedExitCode === 'number' ? waitedExitCode : null;
}

function firstMeaningfulLine(value: string | null): string | null {
  if (!value) return null;
  const line = humanizeEmbeddedNames(
    value
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '',
  ).trim();
  return line.length > 0 ? line : null;
}

export function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
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

// Pull a human-readable first-line summary out of a workflow input.
export function summarizeInput(input: unknown): string {
  if (input == null) return '—';
  if (Array.isArray(input)) {
    if (input.length === 0) return '—';
    const head = summarizeArg(input[0]);
    return input.length > 1 ? `${head} (+${input.length - 1})` : head;
  }
  return summarizeArg(input);
}

/** "Why did this run?" — extracted from input args. For release/phase
 *  workflows the first arg is usually projectName; subsequent args carry
 *  sourceJobId / parentJobId / agentName. */
export function summarizeTrigger(input: unknown): string {
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
export function summarizeOutcome(run: OutcomeInput): { label: string; tone: OutcomeTone } {
  if (run.status === 'running' || run.status === 'pending') {
    return { label: run.status, tone: 'info' };
  }
  if (run.status === 'cancelled') return { label: 'cancelled', tone: 'err' };
  const workflowExitCode = extractDirectWorkflowExitCode(run.output);
  if (isCancelledExitCode(workflowExitCode)) {
    return { label: 'cancelled', tone: 'err' };
  }
  if (run.status === 'failed') {
    const tail = firstMeaningfulLine(run.error)?.slice(0, 60) ?? 'failed';
    return { label: tail, tone: 'err' };
  }
  // Completed: dig into output for verdict / exit code.
  const out = run.output;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string, unknown>;
    const decision = o.decision;
    if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
      const verdict = pickString(decision as Record<string, unknown>, ['verdict']);
      if (verdict) {
        const tone: OutcomeTone = verdict === 'LGTM' ? 'ok' : verdict === 'DO NOT SHIP' ? 'err' : 'warn';
        return { label: verdict, tone };
      }
    }
    const waitedExitCode = extractWaitedJobExitCode(out);
    if (waitedExitCode != null && waitedExitCode !== 0) {
      return { label: `exit ${waitedExitCode}`, tone: 'err' };
    }
    const verdict = pickString(o, ['verdict']);
    if (verdict) {
      const tone: OutcomeTone = verdict === 'LGTM' ? 'ok' : verdict === 'DO NOT SHIP' ? 'err' : 'warn';
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
    if (o.skipped === true) {
      return { label: 'skipped', tone: 'info' };
    }
    if (typeof o.ok === 'boolean') {
      return o.ok ? { label: 'ok', tone: 'ok' } : { label: 'not ok', tone: 'warn' };
    }
  }
  return { label: 'completed', tone: 'ok' };
}

export function summarizeOutcomeDetail(run: OutcomeInput): string | null {
  const out = run.output;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string, unknown>;
    const waited = o.waited;
    if (waited && typeof waited === 'object' && !Array.isArray(waited)) {
      const waitedObj = waited as Record<string, unknown>;
      const waitedJob = waitedObj.job;
      if (waitedJob && typeof waitedJob === 'object' && !Array.isArray(waitedJob)) {
        const jobSummary = firstMeaningfulLine(
          pickString(waitedJob as Record<string, unknown>, ['workSummary', 'detail', 'summary']),
        );
        if (jobSummary) return jobSummary;
      }
    }
    const decision = o.decision;
    if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
      const summary = pickString(decision as Record<string, unknown>, ['summary', 'detail', 'reason']);
      const line = firstMeaningfulLine(summary);
      if (line) return line;
    }
    const summary = firstMeaningfulLine(pickString(o, ['summary', 'detail', 'reason', 'message']));
    if (summary) return summary;
  }
  return firstMeaningfulLine(run.error);
}

export function summarizeWorkflowDisplayStatus(run: OutcomeInput): string {
  if (isCancelledExitCode(extractDirectWorkflowExitCode(run.output))) {
    return 'cancelled';
  }
  return run.status;
}

export function outcomePillTone(tone: OutcomeTone): PillTone {
  switch (tone) {
    case 'ok': return 'success';
    case 'warn': return 'warning';
    case 'err': return 'error';
    case 'info': return 'accent';
  }
}

export function formatTitle(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
