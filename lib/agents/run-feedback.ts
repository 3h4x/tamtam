// Recent-run feedback for prompt improvement.
//
// The "improve prompt" flow rewrites an agent's draft using project context,
// skills, and docs — but on its own it is blind to *how the agent has actually
// been doing*. An agent that produced nothing across its last several runs
// needs a rewrite that targets that failure pattern (broaden the search,
// loosen an over-strict precondition, fix a wrong command), not a generic
// polish. This helper loads the agent's recent finished runs and, when they
// show a low-yield pattern, formats a compact feedback block to inject into
// the improve context so the rewrite can address the real cause.

import { and, desc, eq, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { computeFruitfulness, countFruitfulModifiedFiles, isFruitful, type FruitfulnessSample } from '@/lib/agents/fruitfulness';

export interface RunOutcome {
  startedAt: number;
  exitCode: number | null;
  fruitful: boolean;
  /** Trimmed work summary the agent reported, if any. */
  summary: string | null;
}

interface LoadOpts {
  project: string;
  agentId?: string | null;
  agentName?: string | null;
  /** How many recent finished runs to summarize. Default 5 — enough to show a
   *  pattern without flooding the improve prompt. */
  limit?: number;
}

type AgentMeta = { agent?: { id?: string; name?: string } };

function parseMeta(raw: string | null): AgentMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentMeta;
  } catch {
    return null;
  }
}

function matchesAgent(raw: string | null, agentId: string | null, agentName: string | null, kind: string): boolean {
  const meta = parseMeta(raw);
  if (agentId && meta?.agent?.id) return meta.agent.id === agentId;
  if (agentName && meta?.agent?.name) return meta.agent.name === agentName;
  return !!agentName && kind === `agent:${agentName}`;
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

function noAgentIdPredicate(): SQL {
  return sql`(
    ${schema.jobs.contextMeta} IS NULL
    OR (
      ${schema.jobs.contextMeta} NOT LIKE '%"agent":{"id"%'
      AND ${schema.jobs.contextMeta} NOT LIKE '%"agent": {"id"%'
    )
  )`;
}

function agentContextPredicate(agentId: string | null, agentName: string | null): SQL | undefined {
  const clauses: SQL[] = [];
  if (agentId) clauses.push(jsonStringFieldPredicate('id', agentId));
  if (agentName) {
    const legacyNameFallback = and(noAgentIdPredicate(), jsonStringFieldPredicate('name', agentName));
    const legacyKindFallback = and(noAgentIdPredicate(), eq(schema.jobs.kind, `agent:${agentName}`));
    if (legacyNameFallback) clauses.push(legacyNameFallback);
    if (legacyKindFallback) clauses.push(legacyKindFallback);
  }
  return clauses.length > 0 ? or(...clauses) : undefined;
}

function modifiedFilesCount(rawModifiedFiles: string | null): number {
  if (!rawModifiedFiles) return 0;
  try {
    const arr = JSON.parse(rawModifiedFiles) as unknown[];
    return Array.isArray(arr) ? countFruitfulModifiedFiles(arr) : 0;
  } catch {
    return 0;
  }
}

/** Load the agent's most recent finished runs (manual + scheduled — for the
 *  improve flow we care about all observed behavior, not just scheduled). */
export async function loadRecentRunOutcomes(opts: LoadOpts): Promise<RunOutcome[]> {
  const limit = opts.limit ?? 5;
  const agentId = opts.agentId ?? null;
  const agentName = opts.agentName ?? null;
  const agentPredicate = agentContextPredicate(agentId, agentName);
  const predicates: SQL[] = [
    eq(schema.jobs.project, opts.project),
    like(schema.jobs.kind, 'agent:%'),
    isNotNull(schema.jobs.finishedAt),
  ];
  if (agentPredicate) predicates.push(agentPredicate);

  const rows = await db
    .select({
      kind: schema.jobs.kind,
      startedAt: schema.jobs.startedAt,
      exitCode: schema.jobs.exitCode,
      workSummary: schema.jobs.workSummary,
      modifiedFiles: schema.jobs.modifiedFiles,
      linesAdded: schema.jobs.linesAdded,
      linesRemoved: schema.jobs.linesRemoved,
      contextMeta: schema.jobs.contextMeta,
    })
    .from(schema.jobs)
    .where(and(...predicates))
    .orderBy(desc(schema.jobs.startedAt))
    .limit(limit);

  const out: RunOutcome[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (!matchesAgent(row.contextMeta, agentId, agentName, row.kind)) continue;
    const sample: Pick<FruitfulnessSample, 'modifiedFilesCount' | 'linesAdded' | 'linesRemoved'> = {
      modifiedFilesCount: modifiedFilesCount(row.modifiedFiles),
      linesAdded: row.linesAdded ?? 0,
      linesRemoved: row.linesRemoved ?? 0,
    };
    const summary = row.workSummary?.trim() || null;
    out.push({
      startedAt: row.startedAt,
      exitCode: row.exitCode ?? null,
      fruitful: isFruitful(sample),
      summary: summary ? summary.slice(0, 600) : null,
    });
  }
  return out;
}

/**
 * Build a feedback block for the improve-prompt context, or null when there's
 * nothing useful to add (no runs, or the agent is already producing changes
 * often enough that a failure-targeted rewrite would be noise).
 */
export function formatRunFeedbackBlock(outcomes: RunOutcome[]): string | null {
  if (outcomes.length === 0) return null;
  const samples: FruitfulnessSample[] = outcomes.map((o, i) => ({
    jobId: String(i),
    startedAt: o.startedAt,
    exitCode: o.exitCode,
    modifiedFilesCount: o.fruitful ? 1 : 0,
    linesAdded: 0,
    linesRemoved: 0,
  }));
  const stats = computeFruitfulness(samples);
  // Only inject feedback when the agent has a low-yield pattern worth fixing.
  // A productive agent doesn't need its prompt rewritten around failures.
  if (stats.rate >= 0.5) return null;

  const lines: string[] = [];
  lines.push('## Recent run outcomes (improve around this)');
  lines.push(
    `This agent produced changes in only ${stats.fruitfulRuns} of its last ${stats.runs} runs. ` +
      `When rewriting, diagnose WHY recent runs produced nothing and adjust the prompt so future runs can land real changes — ` +
      `e.g. broaden where it looks, relax an over-strict "only if X" precondition, fix an incorrect command, or widen the scope of acceptable work. ` +
      `Do not invent capabilities the project context does not support.`,
  );
  outcomes.forEach((o, i) => {
    const mark = o.fruitful ? 'changed files' : 'no changes';
    const summary = o.summary ? ` — ${o.summary.replace(/\s+/g, ' ')}` : '';
    lines.push(`- Run ${i + 1} (${mark}, exit ${o.exitCode ?? '?'})${summary}`);
  });
  return lines.join('\n');
}
