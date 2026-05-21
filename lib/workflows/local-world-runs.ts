import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { parse as devalueParse } from 'devalue';

export interface LocalRunFile {
  runId: string;
  workflowName: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  input?: LocalPayload | unknown;
  output?: LocalPayload | unknown;
  // Workflow runtime writes structured errors as { message, stack } objects;
  // legacy rows may be plain strings. normalizeWorkflowError() flattens both.
  error?: unknown;
}

export interface LocalStepFile {
  runId: string;
  stepId: string;
  stepName: string;
  status: string;
  attempt?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  input?: LocalPayload | unknown;
  output?: LocalPayload | unknown;
  // See LocalRunFile.error.
  error?: unknown;
}

interface LocalPayload {
  __type: 'Uint8Array';
  data: string;
}

export interface LocalWorkflowRunSummary {
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

export interface LocalWorkflowStepSummary {
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

export function localWorldDataDir(): string {
  const configured = process.env.WORKFLOW_LOCAL_DATA_DIR || 'data/workflow-data';
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

export function localWorldRunsDir(): string {
  return join(/*turbopackIgnore: true*/ localWorldDataDir(), 'runs');
}

export function localWorldStepsDir(): string {
  return join(/*turbopackIgnore: true*/ localWorldDataDir(), 'steps');
}

export function simplifyWorkflowName(raw: string): string {
  const parts = raw.split('//');
  return parts[parts.length - 1] || raw;
}

// Normalize the workflow `error` column to a stable string. node-pg parses
// jsonb into a JS value, so the column comes back as a string for legacy
// rows but typically `{message, stack}` for structured failures from the
// Workflow runtime. Both shapes appear in the wild; flatten before serving
// so the client can render it directly without per-row type-guarding.
export function normalizeWorkflowError(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export function clampJson(value: unknown, maxBytes = 2_000): unknown {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= maxBytes) return value;
  return { _truncated: true, preview: s.slice(0, maxBytes), originalBytes: s.length };
}

export function decodeLocalPayload(value: unknown): unknown {
  if (
    value != null &&
    typeof value === 'object' &&
    (value as { __type?: string }).__type === 'Uint8Array' &&
    typeof (value as { data?: unknown }).data === 'string'
  ) {
    try {
      const bytes = Buffer.from((value as { data: string }).data, 'base64');
      const str = new TextDecoder().decode(bytes);
      if (str.startsWith('devl')) {
        return devalueParse(str.slice(4));
      }
      try {
        return JSON.parse(str);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }
  return value ?? null;
}

function dateOrNull(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toLocalRunSummary(raw: LocalRunFile): LocalWorkflowRunSummary {
  const created = dateOrNull(raw.createdAt);
  const started = dateOrNull(raw.startedAt);
  const completed = dateOrNull(raw.completedAt);
  return {
    id: raw.runId,
    name: simplifyWorkflowName(raw.workflowName ?? ''),
    rawName: raw.workflowName ?? '',
    status: raw.status,
    createdAt: created ? created.toISOString() : new Date(0).toISOString(),
    startedAt: started ? started.toISOString() : null,
    completedAt: completed ? completed.toISOString() : null,
    durationMs: started && completed ? completed.getTime() - started.getTime() : null,
    input: clampJson(decodeLocalPayload(raw.input)),
    output: clampJson(decodeLocalPayload(raw.output)),
    error: normalizeWorkflowError(raw.error),
  };
}

export function toLocalStepSummary(raw: LocalStepFile): LocalWorkflowStepSummary {
  const created = dateOrNull(raw.createdAt);
  const started = dateOrNull(raw.startedAt);
  const completed = dateOrNull(raw.completedAt);
  return {
    stepId: raw.stepId,
    name: simplifyWorkflowName(raw.stepName ?? ''),
    rawName: raw.stepName ?? '',
    status: raw.status,
    attempt: raw.attempt ?? 1,
    createdAt: created ? created.toISOString() : new Date(0).toISOString(),
    startedAt: started ? started.toISOString() : null,
    completedAt: completed ? completed.toISOString() : null,
    durationMs: started && completed ? completed.getTime() - started.getTime() : null,
    input: clampJson(decodeLocalPayload(raw.input), 4_000),
    output: clampJson(decodeLocalPayload(raw.output), 4_000),
    error: normalizeWorkflowError(raw.error),
  };
}

export function readLocalRunFile(runId: string): LocalRunFile | null {
  const file = join(/*turbopackIgnore: true*/ localWorldRunsDir(), `${runId}.json`);
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8')) as LocalRunFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function readLocalStepFiles(runId: string): LocalStepFile[] {
  const dir = localWorldStepsDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  return readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((name) => name.startsWith(`${runId}-`) && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(dir, name), 'utf8')) as LocalStepFile)
    .sort((a, b) => {
      // ISO 8601 strings sort lexicographically the same as chronologically
      // — skip the Date parse on every comparison.
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return (a.attempt ?? 1) - (b.attempt ?? 1);
    });
}

export function listLocalRunFilesNewestFirst(limit: number): Array<{ name: string; mtime: number }> {
  const dir = localWorldRunsDir();
  const names = readdirSync(/*turbopackIgnore: true*/ dir).filter((n) => n.endsWith('.json'));
  return names.map((name) => {
    let mtime = 0;
    try { mtime = statSync(/*turbopackIgnore: true*/ join(dir, name)).mtimeMs; } catch {}
    return { name, mtime };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
