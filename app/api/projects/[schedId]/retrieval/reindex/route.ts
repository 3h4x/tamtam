import { NextResponse } from 'next/server';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { db, schema } from '@/lib/db';
import { eq, and, inArray } from 'drizzle-orm';
import { PgvectorBackend } from '@/lib/agents/retrieval/pgvector-backend';
import { hashContent, ingestSourceText } from '@/lib/agents/retrieval/ingestion';
import { collectProjectRetrievalSources } from '@/lib/agents/retrieval/project-corpus';

async function upsertRetrievalRecord(opts: {
  id: string;
  project: string;
  sourceKind: string;
  sourceId: string;
  chunkCount: number;
  contentHash: string;
  indexedAt: number;
}): Promise<void> {
  await db.insert(schema.retrievalRecords)
    .values(opts)
    .onConflictDoUpdate({
      target: schema.retrievalRecords.id,
      set: {
        contentHash: opts.contentHash,
        indexedAt: opts.indexedAt,
        chunkCount: opts.chunkCount,
      },
    })
    .execute();
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ schedId: string }> }
): Promise<NextResponse> {
  const { schedId } = await params;
  const cfg = getSettings();

  if (!cfg.retrieval_enabled) {
    return NextResponse.json({ error: 'Retrieval is disabled' }, { status: 400 });
  }

  const projectPath = resolveProjectPath(schedId);
  if (!projectPath) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const backend = new PgvectorBackend();
  let totalChunks = 0;

  try {
    const sources = await collectProjectRetrievalSources(schedId, projectPath);
    const sourceKinds = ['project_doc', 'skill', 'project_config'] as const;
    const currentIds = new Set(sources.map((source) => source.recordId));
    const existingRecords = await db.select()
      .from(schema.retrievalRecords)
      .where(and(
        eq(schema.retrievalRecords.project, schedId),
        inArray(schema.retrievalRecords.sourceKind, [...sourceKinds])
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
      });
    }

    for (const record of existingRecords) {
      if (currentIds.has(record.id)) continue;
      await backend.deleteSource(schedId, record.sourceKind as 'project_doc' | 'skill' | 'project_config', record.sourceId);
      await db.delete(schema.retrievalRecords).where(eq(schema.retrievalRecords.id, record.id)).execute();
      staleCount += 1;
    }

    return NextResponse.json({
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
    });
  } catch (err) {
    console.error('[retrieval] reindex failed:', err);
    return NextResponse.json({ error: 'Reindex failed' }, { status: 500 });
  }
}
