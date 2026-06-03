// Agent run "fruitfulness" — did the agent actually produce anything.
//
// The orchestrator's boost ranking and the recommendation surface both need to
// answer the same question: across this agent's recent runs, how often did it
// actually change files / move lines of code? An agent that ran 10 times in
// the last day and made zero changes is wasting boost slots and pace headroom
// that a productive agent could use instead.
//
// Pure data-in / data-out so it's unit-testable without spinning up the DB.
// The two DB-backed helpers at the bottom are thin loaders that hand a list
// of samples to `computeFruitfulness`.

import { db, schema } from '@/lib/db';
import { and, desc, eq, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import type { JobData } from '@/lib/jobs/types';

export interface FruitfulnessSample {
  jobId: string;
  startedAt: number;
  exitCode: number | null;
  modifiedFilesCount: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface FruitfulnessStats {
  /** Number of finished runs included in this sample. */
  runs: number;
  /** Runs where the agent produced *something* (file or line). */
  fruitfulRuns: number;
  /** `fruitfulRuns / runs`. 0 when `runs` is 0 (no data ⇒ no penalty). */
  rate: number;
  /** Sum of `linesAdded + linesRemoved` across all runs in the sample. */
  totalLinesChanged: number;
  /** Sum of `modifiedFilesCount` across all runs in the sample. */
  totalFilesChanged: number;
  /** Most recent run timestamp in the sample (unix seconds), or null. */
  lastRunAt: number | null;
}

/** A sample counts as fruitful when the agent changed at least one file OR
 *  moved at least one line of code. Either signal alone is enough — binary
 *  file changes show as files=1, lines=0; a pure rename can move 0 lines
 *  but still leave a real, reviewable change behind. */
export function isFruitful(
  sample: Pick<FruitfulnessSample, 'modifiedFilesCount' | 'linesAdded' | 'linesRemoved'>,
): boolean {
  return sample.modifiedFilesCount > 0 || sample.linesAdded > 0 || sample.linesRemoved > 0;
}

export function computeFruitfulness(samples: FruitfulnessSample[]): FruitfulnessStats {
  const runs = samples.length;
  if (runs === 0) {
    return { runs: 0, fruitfulRuns: 0, rate: 0, totalLinesChanged: 0, totalFilesChanged: 0, lastRunAt: null };
  }
  let fruitfulRuns = 0;
  let totalLinesChanged = 0;
  let totalFilesChanged = 0;
  let lastRunAt = -Infinity;
  for (const s of samples) {
    if (isFruitful(s)) fruitfulRuns++;
    totalLinesChanged += (s.linesAdded ?? 0) + (s.linesRemoved ?? 0);
    totalFilesChanged += s.modifiedFilesCount;
    if (s.startedAt > lastRunAt) lastRunAt = s.startedAt;
  }
  return {
    runs,
    fruitfulRuns,
    rate: fruitfulRuns / runs,
    totalLinesChanged,
    totalFilesChanged,
    lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
  };
}

/** Convert a JobData row into a fruitfulness sample. Returns null for non-
 *  agent jobs so callers can filter unconditionally. Tolerant of legacy rows
 *  where `linesAdded` / `linesRemoved` are nullable (pre-migration 0020). */
export function jobToSample(job: JobData): FruitfulnessSample | null {
  if (!isAgentJobKind(job.kind)) return null;
  if (job.finishedAt == null) return null;
  let modifiedFilesCount = 0;
  if (job.modifiedFiles) {
    try {
      const arr = JSON.parse(job.modifiedFiles) as unknown[];
      if (Array.isArray(arr)) modifiedFilesCount = countFruitfulModifiedFiles(arr);
    } catch {
      // Malformed JSON — treat as 0 rather than crashing the aggregator.
    }
  }
  return {
    jobId: job.id,
    startedAt: job.startedAt,
    exitCode: job.exitCode ?? null,
    modifiedFilesCount,
    linesAdded: job.linesAdded ?? 0,
    linesRemoved: job.linesRemoved ?? 0,
  };
}

export function countFruitfulModifiedFiles(arr: unknown[]): number {
  let count = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') {
      count++;
      continue;
    }
    const confidence = (item as { confidence?: unknown }).confidence;
    if (confidence === 'low') continue;
    count++;
  }
  return count;
}

interface LoadOpts {
  project: string;
  /** Match on the agent's stable id when available. Agent name is used only
   *  for legacy/name-only callers so same-name recreated agents cannot crowd
   *  each other out before pagination. */
  agentId?: string | null;
  agentName?: string | null;
  /** How many recent finished runs to sample. Defaults to 10 — large enough
   *  to smooth out a single off-day, small enough to react quickly when an
   *  agent stops producing. */
  limit?: number;
}

type AgentContextMeta = {
  agent?: {
    id?: string;
    name?: string;
    triggeredBy?: string;
  };
};

function parseAgentMeta(rawMeta: string | null): AgentContextMeta | null {
  if (!rawMeta) return null;
  try {
    return JSON.parse(rawMeta) as AgentContextMeta;
  } catch {
    return null;
  }
}

function isScheduledRun(rawMeta: string | null): boolean {
  return parseAgentMeta(rawMeta)?.agent?.triggeredBy === 'schedule';
}

function scheduledRunContextPredicate() {
  // `context_meta` is stored as text, not jsonb. Filter the common serialized
  // shapes before LIMIT so newer manual runs cannot crowd scheduled samples
  // out of the DB page; the JS parser below remains the source of truth.
  return sql`(${schema.jobs.contextMeta} LIKE '%"triggeredBy":"schedule"%' OR ${schema.jobs.contextMeta} LIKE '%"triggeredBy": "schedule"%')`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function jsonStringFieldPredicate(field: 'id' | 'name', value: string): SQL {
  const encoded = escapeLikePattern(JSON.stringify(value).slice(1, -1));
  return sql`(
    ${schema.jobs.contextMeta} LIKE ${`%"${field}":"${encoded}"%`} ESCAPE '\\'
    OR ${schema.jobs.contextMeta} LIKE ${`%"${field}": "${encoded}"%`} ESCAPE '\\'
  )`;
}

function agentContextPredicate(agentId: string | null, agentName: string | null): SQL | undefined {
  if (agentId) return jsonStringFieldPredicate('id', agentId);
  const clauses: SQL[] = [];
  if (agentName) {
    clauses.push(jsonStringFieldPredicate('name', agentName));
    clauses.push(eq(schema.jobs.kind, `agent:${agentName}`));
  }
  return clauses.length > 0 ? or(...clauses) : undefined;
}

/** Load the N most recent finished agent jobs scoped to (project, agentId)
 *  and return them as fruitfulness samples. Reads `context_meta` to filter
 *  by agent id/name before pagination so busy sibling agents cannot evict the
 *  target agent's own recent scheduled history. */
export async function loadRecentAgentSamples(opts: LoadOpts): Promise<FruitfulnessSample[]> {
  const limit = opts.limit ?? 10;
  const agentPredicate = agentContextPredicate(opts.agentId ?? null, opts.agentName ?? null);
  const predicates: SQL[] = [
    eq(schema.jobs.project, opts.project),
    like(schema.jobs.kind, 'agent:%'),
    isNotNull(schema.jobs.finishedAt),
    scheduledRunContextPredicate(),
  ];
  if (agentPredicate) predicates.push(agentPredicate);
  const rows = await db
    .select({
      id: schema.jobs.id,
      kind: schema.jobs.kind,
      startedAt: schema.jobs.startedAt,
      exitCode: schema.jobs.exitCode,
      modifiedFiles: schema.jobs.modifiedFiles,
      linesAdded: schema.jobs.linesAdded,
      linesRemoved: schema.jobs.linesRemoved,
      contextMeta: schema.jobs.contextMeta,
    })
    .from(schema.jobs)
    .where(and(...predicates))
    .orderBy(desc(schema.jobs.startedAt))
    .limit(limit);

  const samples: FruitfulnessSample[] = [];
  for (const row of rows) {
    if (samples.length >= limit) break;
    if (!isScheduledRun(row.contextMeta)) continue;
    if (!matchesAgent(row.contextMeta, opts.agentId ?? null, opts.agentName ?? null, row.kind)) continue;
    let modifiedFilesCount = 0;
    if (row.modifiedFiles) {
      try {
        const arr = JSON.parse(row.modifiedFiles) as unknown[];
        if (Array.isArray(arr)) modifiedFilesCount = countFruitfulModifiedFiles(arr);
      } catch {
        // ignore
      }
    }
    samples.push({
      jobId: row.id,
      startedAt: row.startedAt,
      exitCode: row.exitCode ?? null,
      modifiedFilesCount,
      linesAdded: row.linesAdded ?? 0,
      linesRemoved: row.linesRemoved ?? 0,
    });
  }
  return samples;
}

function matchesAgent(
  rawMeta: string | null,
  agentId: string | null,
  agentName: string | null,
  kind: string,
): boolean {
  // When context_meta is missing we can only fall back by kind suffix. The
  // scheduled-run guard runs before this helper, so unknown-trigger rows do
  // not affect fruitfulness.
  if (!rawMeta) {
    if (!agentName) return false;
    return kind === `agent:${agentName}`;
  }
  const meta = parseAgentMeta(rawMeta);
  if (agentId && meta?.agent?.id) return meta.agent.id === agentId;
  if (agentName && meta?.agent?.name) return meta.agent.name === agentName;
  if (agentName && kind === `agent:${agentName}`) return true;
  return false;
}

/** Load fruitfulness rates for every enabled agent in one pass, keyed by
 *  agent id. Optimized for the orchestrator boost tick which needs a stat
 *  for *every* agent in `BoostInput.agents` — issuing one query per agent
 *  would be `O(agents * round-trips)` and starve the tick. The single
 *  query here is `O(agents)` server-side. */
export async function loadAllAgentFruitfulness(opts: {
  limit?: number;
}): Promise<Map<string, FruitfulnessStats>> {
  const perAgent = opts.limit ?? 10;
  // Pull recent finished scheduled agent jobs for the whole workspace and
  // bucket them by agent id in JS. The 14-day bound limits growth, but there
  // is intentionally no global LIMIT before bucketing: a high-volume sibling
  // agent must not evict another agent's own recent scheduled sample.
  const rows = await db
    .select({
      id: schema.jobs.id,
      kind: schema.jobs.kind,
      project: schema.jobs.project,
      startedAt: schema.jobs.startedAt,
      exitCode: schema.jobs.exitCode,
      modifiedFiles: schema.jobs.modifiedFiles,
      linesAdded: schema.jobs.linesAdded,
      linesRemoved: schema.jobs.linesRemoved,
      contextMeta: schema.jobs.contextMeta,
    })
    .from(schema.jobs)
    .where(and(
      like(schema.jobs.kind, 'agent:%'),
      isNotNull(schema.jobs.finishedAt),
      scheduledRunContextPredicate(),
      // Time-bound the scan so an old workspace doesn't drag in stale
      // history that no longer reflects the agent's current behavior.
      sql`${schema.jobs.startedAt} > ${Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60}`,
    ))
    .orderBy(desc(schema.jobs.startedAt));

  const byAgent = new Map<string, FruitfulnessSample[]>();
  for (const row of rows) {
    const meta = parseAgentMeta(row.contextMeta);
    const agentMeta = meta?.agent;
    if (agentMeta?.triggeredBy !== 'schedule') continue;
    let agentId: string | null = null;
    let agentName: string | null = null;
    agentId = agentMeta.id ?? null;
    agentName = agentMeta.name ?? null;
    // Fall back to a synthetic id when scheduled context_meta has a name but
    // no id. Rows without `triggeredBy: "schedule"` are ignored so manual
    // operator runs never push an agent toward boost demotion.
    const key = agentId ?? (agentName ? `${row.project}:${agentName}` : null);
    if (!key) continue;
    let bucket = byAgent.get(key);
    if (!bucket) {
      bucket = [];
      byAgent.set(key, bucket);
    }
    if (bucket.length >= perAgent) continue;
    let modifiedFilesCount = 0;
    if (row.modifiedFiles) {
      try {
        const arr = JSON.parse(row.modifiedFiles) as unknown[];
        if (Array.isArray(arr)) modifiedFilesCount = countFruitfulModifiedFiles(arr);
      } catch {
        // ignore
      }
    }
    bucket.push({
      jobId: row.id,
      startedAt: row.startedAt,
      exitCode: row.exitCode ?? null,
      modifiedFilesCount,
      linesAdded: row.linesAdded ?? 0,
      linesRemoved: row.linesRemoved ?? 0,
    });
  }

  const out = new Map<string, FruitfulnessStats>();
  for (const [agentKey, samples] of byAgent.entries()) {
    out.set(agentKey, computeFruitfulness(samples));
  }
  return out;
}
