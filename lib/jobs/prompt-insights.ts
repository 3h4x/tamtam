// Per-project aggregates over recent jobs so the project overview can show
// "what's actually in our prompts and how is retrieval performing?" without
// the operator having to grep `.prompt` files by hand.
//
// All numbers are computed from rows in the `jobs` table — specifically the
// `prompt_bytes` column and structured fields under `contextMeta.composition`
// + `contextMeta.retrieval` populated by `lib/agents/intake-workflow.ts`.
// Older jobs (pre-rollout) silently drop out of the aggregates because they
// lack the structured fields; the counts reported below are over jobs that
// actually have data.

import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

export interface PromptInsights {
  windowDays: number;
  agentJobCount: number;
  promptBytes: {
    avg: number;
    p50: number;
    p95: number;
    max: number;
  } | null;
  retrieval: {
    sampled: number;
    queried: number;
    attached: number;
    queriedRate: number;
    attachRate: number;
    avgTopScore: number | null;
    avgAcceptedChunks: number | null;
    reasons: Record<string, number>;
  };
  memory: {
    sampled: number;
    truncatedCount: number;
    truncationRate: number;
    avgRawChars: number | null;
    maxRawChars: number;
  };
  prereq: {
    withPrereq: number;
    withoutPrereq: number;
  };
}

interface ContextMetaShape {
  composition?: {
    mode?: string;
    skillCount?: number;
    attachedDocCount?: number;
    autoAttachedCount?: number;
    memory?: { state?: string; truncated?: boolean; rawChars?: number };
    hasPrereq?: boolean;
  };
  retrieval?: {
    status?: string;
    reason?: string;
    corpusChunkCount?: number;
    retrievedCount?: number;
    acceptedCount?: number;
    topScore?: number | null;
    scoreThreshold?: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function computePromptInsights(
  project: string,
  windowDays: number,
): Promise<PromptInsights> {
  const cutoffSec = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const rows = await db
    .select({ kind: schema.jobs.kind, promptBytes: schema.jobs.promptBytes, contextMeta: schema.jobs.contextMeta })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.project, project),
      gt(schema.jobs.finishedAt, cutoffSec),
      isNotNull(schema.jobs.finishedAt),
    ));

  // Only agent jobs go through the intake-workflow composition path that
  // populates the structured fields. Pipeline phases (review/fix/commit/etc)
  // build their own prompts and don't carry the same diagnostic shape, so
  // including them here would skew everything toward "no retrieval data".
  const agentRows = rows.filter((r) => r.kind.startsWith('agent:'));

  const promptSizes = agentRows
    .map((r) => r.promptBytes ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  const promptBytes = promptSizes.length === 0
    ? null
    : {
        avg: Math.round(promptSizes.reduce((s, n) => s + n, 0) / promptSizes.length),
        p50: percentile(promptSizes, 50),
        p95: percentile(promptSizes, 95),
        max: promptSizes[promptSizes.length - 1],
      };

  const parsedMetas: ContextMetaShape[] = agentRows
    .map((r) => {
      if (!r.contextMeta) return null;
      try {
        return JSON.parse(r.contextMeta) as ContextMetaShape;
      } catch {
        return null;
      }
    })
    .filter((m): m is ContextMetaShape => m !== null);

  const withRetrievalDiag = parsedMetas.filter((m) => m.retrieval);
  const retrievalQueried = withRetrievalDiag.filter((m) => {
    const r = m.retrieval?.reason ?? '';
    return r !== '' && r !== 'disabled' && r !== 'skipped';
  });
  const retrievalAttached = withRetrievalDiag.filter((m) => (m.retrieval?.acceptedCount ?? 0) > 0);
  const topScores = withRetrievalDiag
    .map((m) => m.retrieval?.topScore)
    .filter((s): s is number => typeof s === 'number');
  const accepted = withRetrievalDiag
    .map((m) => m.retrieval?.acceptedCount ?? 0);
  const reasonCounts: Record<string, number> = {};
  for (const m of withRetrievalDiag) {
    const r = m.retrieval?.reason ?? 'unknown';
    reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  }

  const withComposition = parsedMetas.filter((m) => m.composition?.memory);
  const truncated = withComposition.filter((m) => m.composition?.memory?.truncated === true);
  const memoryRawChars = withComposition
    .map((m) => m.composition?.memory?.rawChars ?? 0)
    .filter((n) => n > 0);

  const withPrereq = parsedMetas.filter((m) => m.composition?.hasPrereq === true).length;
  const withoutPrereq = parsedMetas.filter((m) => m.composition?.hasPrereq === false).length;

  return {
    windowDays,
    agentJobCount: agentRows.length,
    promptBytes,
    retrieval: {
      sampled: withRetrievalDiag.length,
      queried: retrievalQueried.length,
      attached: retrievalAttached.length,
      queriedRate: withRetrievalDiag.length === 0 ? 0 : retrievalQueried.length / withRetrievalDiag.length,
      attachRate: retrievalQueried.length === 0 ? 0 : retrievalAttached.length / retrievalQueried.length,
      avgTopScore: topScores.length === 0 ? null : topScores.reduce((s, n) => s + n, 0) / topScores.length,
      avgAcceptedChunks: accepted.length === 0 ? null : accepted.reduce((s, n) => s + n, 0) / accepted.length,
      reasons: reasonCounts,
    },
    memory: {
      sampled: withComposition.length,
      truncatedCount: truncated.length,
      truncationRate: withComposition.length === 0 ? 0 : truncated.length / withComposition.length,
      avgRawChars: memoryRawChars.length === 0 ? null : Math.round(memoryRawChars.reduce((s, n) => s + n, 0) / memoryRawChars.length),
      maxRawChars: memoryRawChars.length === 0 ? 0 : Math.max(...memoryRawChars),
    },
    prereq: {
      withPrereq,
      withoutPrereq,
    },
  };
}
