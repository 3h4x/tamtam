import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { PgvectorBackend } from './pgvector-backend';
import { hashContent, ingestSourceText } from './ingestion';
import { collectProjectRetrievalSources } from './project-corpus';
import type { SourceKind } from './backend';

export interface ReindexResult {
  ok: boolean;
  status: number;
  chunks: number;
  indexedSources: number;
  skippedSources: number;
  diagnostics: {
    status: 'ok' | 'warning' | 'disabled' | 'missing_project' | 'error';
    reason: string;
    missingSourcesBeforeReindex: number;
    staleSourcesBeforeReindex: number;
    sourceCounts: Record<string, number>;
  };
  error?: string;
}

async function upsertRetrievalRecord(opts: {
  id: string;
  project: string;
  sourceKind: string;
  sourceId: string;
  chunkCount: number;
  contentHash: string;
  indexedAt: number;
  embeddingModel: string;
}): Promise<void> {
  await db.insert(schema.retrievalRecords)
    .values(opts)
    .onConflictDoUpdate({
      target: schema.retrievalRecords.id,
      set: {
        contentHash: opts.contentHash,
        indexedAt: opts.indexedAt,
        chunkCount: opts.chunkCount,
        embeddingModel: opts.embeddingModel,
      },
    })
    .execute();
}

function emptyDiagnostics(
  status: ReindexResult['diagnostics']['status'],
  reason: string
): ReindexResult['diagnostics'] {
  return {
    status,
    reason,
    missingSourcesBeforeReindex: 0,
    staleSourcesBeforeReindex: 0,
    sourceCounts: { project_doc: 0, skill: 0, project_config: 0 },
  };
}

export async function reindexProject(schedId: string): Promise<ReindexResult> {
  const cfg = getSettings();

  if (!cfg.retrieval_enabled) {
    return {
      ok: false,
      status: 400,
      chunks: 0,
      indexedSources: 0,
      skippedSources: 0,
      diagnostics: emptyDiagnostics('disabled', 'retrieval_disabled'),
      error: 'Retrieval is disabled',
    };
  }

  const projectPath = resolveProjectPath(schedId);
  if (!projectPath) {
    return {
      ok: false,
      status: 404,
      chunks: 0,
      indexedSources: 0,
      skippedSources: 0,
      diagnostics: emptyDiagnostics('missing_project', 'project_not_found'),
      error: 'Project not found',
    };
  }

  const backend = new PgvectorBackend();
  let totalChunks = 0;

  try {
    const sources = await collectProjectRetrievalSources(schedId, projectPath);
    const sourceKinds: SourceKind[] = ['project_doc', 'skill', 'project_config'];
    const currentIds = new Set(sources.map((source) => source.recordId));
    const existingRecords = await db.select()
      .from(schema.retrievalRecords)
      .where(and(
        eq(schema.retrievalRecords.project, schedId),
        inArray(schema.retrievalRecords.sourceKind, sourceKinds)
      ));
    const existingById = new Map(existingRecords.map((record) => [record.id, record]));

    let missingCount = 0;
    let staleCount = 0;
    let indexedCount = 0;
    let skippedCount = 0;
    const sourceCounts: Record<string, number> = { project_doc: 0, skill: 0, project_config: 0 };

    for (const source of sources) {
      sourceCounts[source.sourceKind] = (sourceCounts[source.sourceKind] ?? 0) + 1;
      const existing = existingById.get(source.recordId);
      const contentHash = hashContent(source.text);
      const timestampStale =
        !!existing && source.updatedAt != null && existing.indexedAt < source.updatedAt;
      const isMissing = !existing;
      const isStale = !!existing && (existing.contentHash !== contentHash || timestampStale);
      if (isMissing) missingCount += 1;
      else if (isStale) staleCount += 1;

      const { chunkCount, skipped, stored, contentHash: storedHash } = await ingestSourceText({
        backend,
        project: schedId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        text: source.text,
        metadata: source.metadata,
        ollamaUrl: cfg.retrieval_ollama_url,
        embeddingModel: cfg.retrieval_embedding_model,
        existingHash: existing?.contentHash ?? null,
      });
      if (skipped) {
        skippedCount += 1;
        if (timestampStale && existing) {
          await upsertRetrievalRecord({
            id: source.recordId,
            project: schedId,
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            chunkCount: existing.chunkCount,
            contentHash: existing.contentHash,
            indexedAt: Date.now() / 1000,
            embeddingModel: cfg.retrieval_embedding_model,
          });
        }
        continue;
      }
      if (!stored) {
        throw new Error(`Failed to index ${source.sourceKind}:${source.sourceId}`);
      }
      indexedCount += 1;
      totalChunks += chunkCount;

      await upsertRetrievalRecord({
        id: source.recordId,
        project: schedId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        chunkCount,
        contentHash: storedHash,
        indexedAt: Date.now() / 1000,
        embeddingModel: cfg.retrieval_embedding_model,
      });
    }

    // Stale-record cleanup: each pair (backend.deleteSource + db.delete) is
    // independent across records — parallelize so reindex doesn't pay N
    // round-trips when many sources were removed.
    const staleRecords = existingRecords.filter((record) => !currentIds.has(record.id));
    await Promise.all(staleRecords.map(async (record) => {
      await backend.deleteSource(
        schedId,
        record.sourceKind as 'project_doc' | 'skill' | 'project_config',
        record.sourceId,
      );
      await db.delete(schema.retrievalRecords).where(eq(schema.retrievalRecords.id, record.id)).execute();
    }));
    staleCount += staleRecords.length;

    return {
      ok: true,
      status: 200,
      chunks: totalChunks,
      indexedSources: indexedCount,
      skippedSources: skippedCount,
      diagnostics: {
        status: sources.length > 0 ? 'ok' : 'warning',
        reason: sources.length > 0 ? 'indexed' : 'empty_corpus',
        missingSourcesBeforeReindex: missingCount,
        staleSourcesBeforeReindex: staleCount,
        sourceCounts,
      },
    };
  } catch (err) {
    console.error('[retrieval] reindex failed:', err);
    return {
      ok: false,
      status: 500,
      chunks: totalChunks,
      indexedSources: 0,
      skippedSources: 0,
      diagnostics: emptyDiagnostics('error', 'reindex_failed'),
      error: 'Reindex failed',
    };
  }
}

export async function wipeProjectRetrieval(schedId: string): Promise<void> {
  const backend = new PgvectorBackend();
  await backend.deleteProject(schedId);
  await db.delete(schema.retrievalRecords)
    .where(eq(schema.retrievalRecords.project, schedId))
    .execute();
}
