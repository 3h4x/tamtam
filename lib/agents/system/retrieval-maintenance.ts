// Built-in per-project agent that keeps the pgvector retrieval index in sync
// with on-disk docs/skills/config, handles embedding-model drift by wiping
// and re-indexing the affected project, and finishes with a cheap-LLM
// verification that retrieval still returns plausibly-relevant snippets.
//
// Auto-seeded per project (see ./seed.ts) and dispatched by the cron task
// when agent.kind === 'system'. Does NOT spawn a CLI: writes a job row,
// performs the work in-process, stashes `retrievalHealth` in
// contextMeta, then persists directly (bypassing markDone — the post-
// processing chain assumes a CLI session with stream-json output that
// system agents don't produce).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { AgentInput } from '@/lib/scheduling/agent-types';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, updateJob } from '@/lib/jobs/job-storage';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { reindexProject, wipeProjectRetrieval, type ReindexResult } from '@/lib/agents/retrieval/reindex-project';
import { PgvectorBackend } from '@/lib/agents/retrieval/pgvector-backend';
import { retrieveAgentContextDetailed } from '@/lib/agents/retrieval/retriever';
import { verifyRetrievalWithCheapModel, type VerifyResult } from './verify-with-cheap-model';
import { listProjectDocuments } from '@/lib/shared/project-documents';

export const DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME = 'documentation-reindex-vectors';
export const DOCUMENTATION_REINDEX_VECTORS_JOB_KIND = 'agent:documentation-reindex-vectors';

interface RetrievalHealthMeta {
  agentId: string;
  agentName: string;
  wiped: boolean;
  reindexStatus: ReindexResult['diagnostics']['status'];
  chunks: number;
  indexedSources: number;
  skippedSources: number;
  sampleQuery?: string;
  verdict?: VerifyResult['verdict'] | null;
  reason?: string;
  verifierModel?: string;
  verifiedAt?: string;
  retrievalDiagnostics?: {
    corpusChunkCount: number;
    retrievedCount: number;
    acceptedCount: number;
    topScore: number | null;
    scoreThreshold: number;
  };
  error?: string;
}

function resolveLogDir(): string {
  try {
    return getImproveConfig().logDir;
  } catch {
    return join(/*turbopackIgnore: true*/ homedir(), 'logs');
  }
}

function writeLog(logPath: string, body: string): void {
  try {
    mkdirSync(/*turbopackIgnore: true*/ join(logPath, '..'), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ logPath, body, 'utf-8');
  } catch (err) {
    console.warn('[documentation-reindex-vectors] failed to write log:', err);
  }
}

function deriveSampleQuery(projectPath: string, projectName: string): string {
  // Prefer the first H1 from CLAUDE.md so the verifier query feels native to
  // the project. Fall back to README.md, then to a generic project-named
  // probe. The cheap LLM only needs *something* the corpus could plausibly
  // surface — exact wording doesn't matter much for the verification.
  for (const candidate of ['CLAUDE.md', 'README.md']) {
    const path = join(projectPath, candidate);
    if (!existsSync(/*turbopackIgnore: true*/ path)) continue;
    try {
      const text = readFileSync(/*turbopackIgnore: true*/ path, 'utf-8');
      const match = text.match(/^#\s+(.+)$/m);
      if (match && match[1]) {
        return match[1].trim().slice(0, 120);
      }
    } catch { /* ignore */ }
  }
  // Best-effort topic synthesis from the first project doc.
  try {
    const docs = listProjectDocuments(projectPath, { includeAgentDocs: false });
    for (const doc of docs) {
      if (!existsSync(/*turbopackIgnore: true*/ doc)) continue;
      const text = readFileSync(/*turbopackIgnore: true*/ doc, 'utf-8');
      const match = text.match(/^#\s+(.+)$/m);
      if (match && match[1]) return match[1].trim().slice(0, 120);
    }
  } catch { /* ignore */ }
  return `${projectName} overview`;
}

async function detectModelMismatch(project: string, currentModel: string): Promise<boolean> {
  const rows = await db
    .select({ embeddingModel: schema.retrievalRecords.embeddingModel })
    .from(schema.retrievalRecords)
    .where(and(
      eq(schema.retrievalRecords.project, project),
      isNotNull(schema.retrievalRecords.embeddingModel),
      ne(schema.retrievalRecords.embeddingModel, currentModel),
    ))
    .limit(1);
  return rows.length > 0;
}

function summarize(meta: RetrievalHealthMeta): string {
  const wipeNote = meta.wiped ? 'wiped + ' : '';
  const verifyNote = meta.verdict === null || meta.verdict === undefined
    ? 'verify: skipped (verifier unavailable)'
    : `verify: ${meta.verdict}${meta.reason ? ` — ${meta.reason}` : ''}`;
  return [
    `${wipeNote}reindex: ${meta.indexedSources} indexed, ${meta.skippedSources} skipped, ${meta.chunks} chunks`,
    verifyNote,
    meta.error ? `error: ${meta.error}` : null,
  ].filter(Boolean).join('\n');
}

export async function runRetrievalMaintenance(agent: AgentInput): Promise<{ jobId: string }> {
  const cfg = getSettings();
  const logDir = resolveLogDir();
  const logPath = join(/*turbopackIgnore: true*/ logDir, '__pending__.log');

  const initialMeta: RetrievalHealthMeta = {
    agentId: agent.id,
    agentName: agent.name,
    wiped: false,
    reindexStatus: 'ok',
    chunks: 0,
    indexedSources: 0,
    skippedSources: 0,
  };
  const initialContextMeta = JSON.stringify({
    agentId: agent.id,
    agentName: agent.name,
    system: true,
    retrievalHealth: initialMeta,
  });

  const job = createJob(
    agent.project,
    DOCUMENTATION_REINDEX_VECTORS_JOB_KIND,
    0,
    logPath,
    '[system] documentation-reindex-vectors',
    initialContextMeta,
    undefined,
    null,
    null,
    null,
    null,
    null,
  );
  // Now we know the job id; rewrite logPath to the canonical filename.
  const realLogPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = realLogPath;

  let meta: RetrievalHealthMeta = { ...initialMeta };
  let exitCode = 0;

  try {
    if (!cfg.retrieval_enabled) {
      meta.error = 'retrieval_disabled';
      meta.reindexStatus = 'disabled';
      writeLog(realLogPath, 'Retrieval is disabled — skipping.\n');
      // exit cleanly so user can re-enable without seeing a red row
    } else {
      const projectPath = resolveProjectPath(agent.project);
      if (!projectPath) {
        meta.error = 'project_not_found';
        meta.reindexStatus = 'missing_project';
        exitCode = 1;
      } else {
        const needsWipe = await detectModelMismatch(agent.project, cfg.retrieval_embedding_model);
        if (needsWipe) {
          await wipeProjectRetrieval(agent.project);
          meta.wiped = true;
        }

        const result = await reindexProject(agent.project);
        meta.chunks = result.chunks;
        meta.indexedSources = result.indexedSources;
        meta.skippedSources = result.skippedSources;
        meta.reindexStatus = result.diagnostics.status;
        if (!result.ok) {
          meta.error = result.error ?? 'reindex_failed';
          exitCode = 1;
        } else {
          // Verification step — only meaningful if there is content to retrieve.
          const sampleQuery = deriveSampleQuery(projectPath, agent.project);
          meta.sampleQuery = sampleQuery;
          const backend = new PgvectorBackend();
          const retrieval = await retrieveAgentContextDetailed({
            backend,
            project: agent.project,
            taskPrompt: sampleQuery,
            limit: 5,
            scoreThreshold: 0, // ignore threshold here — we want to verify whatever the index returns
            ollamaUrl: cfg.retrieval_ollama_url,
            embeddingModel: cfg.retrieval_embedding_model,
          });
          meta.retrievalDiagnostics = {
            corpusChunkCount: retrieval.diagnostics.corpusChunkCount,
            retrievedCount: retrieval.diagnostics.retrievedCount,
            acceptedCount: retrieval.diagnostics.acceptedCount,
            topScore: retrieval.diagnostics.topScore,
            scoreThreshold: retrieval.diagnostics.scoreThreshold,
          };

          if ((retrieval.diagnostics.sources?.length ?? 0) > 0) {
            const verifier = await verifyRetrievalWithCheapModel({
              project: agent.project,
              query: sampleQuery,
              snippets: (retrieval.diagnostics.sources ?? []).map((s) => ({
                sourceKind: s.sourceKind,
                sourceId: s.sourceId,
                text: s.preview,
              })),
            }, {
              ollamaUrl: cfg.retrieval_ollama_url,
              model: cfg.outcome_classifier_model,
            });
            if (verifier) {
              meta.verdict = verifier.verdict;
              meta.reason = verifier.reason;
              meta.verifierModel = verifier.model;
              meta.verifiedAt = verifier.verifiedAt;
            } else {
              meta.verdict = null;
              meta.reason = 'verifier_unavailable';
            }
          } else {
            meta.verdict = null;
            meta.reason = 'no_snippets_to_verify';
          }
        }
      }
    }
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  const summary = summarize(meta);
  writeLog(realLogPath, `${summary}\n`);

  job.finishedAt = Date.now() / 1000;
  job.exitCode = exitCode;
  job.workSummary = summary;
  job.contextMeta = JSON.stringify({
    agentId: agent.id,
    agentName: agent.name,
    system: true,
    retrievalHealth: meta,
  });
  job.seen = true; // system agents don't need user attention on success
  updateJob(job);

  // Surface obvious failures via console so PM2 captures them.
  if (exitCode !== 0) {
    console.warn(`[documentation-reindex-vectors] ${agent.project}: ${summary}`);
  }

  return { jobId: job.id };
}

export const __testing = {
  detectModelMismatch,
  deriveSampleQuery,
  summarize,
};
