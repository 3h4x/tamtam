import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { db, schema, sqlite } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { embedText } from '@/lib/agents/retrieval/ollama-embedder';
import { chunkText } from '@/lib/agents/retrieval/chunker';
import { hashContent } from '@/lib/agents/retrieval/ingestion';
import type { SourceKind } from '@/lib/agents/retrieval/backend';
import { listProjectDocuments } from '@/lib/shared/project-documents';
import { getSqliteVecUnavailableDetail, isSqliteVecAvailable } from '@/lib/db/sqlite-vec';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ schedId: string }> }
): Promise<NextResponse> {
  const { schedId } = await params;
  const cfg = getSettings();

  if (!cfg.retrieval_enabled) {
    return NextResponse.json({ error: 'Retrieval is disabled' }, { status: 400 });
  }
  if (!isSqliteVecAvailable()) {
    return NextResponse.json(
      { error: getSqliteVecUnavailableDetail(), code: 'sqlite_vec_unavailable' },
      { status: 503 }
    );
  }

  const projectPath = resolveProjectPath(schedId);
  if (!projectPath) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const backend = new SqliteVecBackend(sqlite);
  let totalChunks = 0;

  try {
    const files = listProjectDocuments(projectPath);

    for (const filePath of files) {
      if (!existsSync(/*turbopackIgnore: true*/ filePath)) continue;
      const text = readFileSync(/*turbopackIgnore: true*/ filePath, 'utf-8');
      const relPath = filePath.replace(projectPath + '/', '');
      const contentHash = hashContent(text);
      const recordId = `${schedId}:project_doc:${relPath}`;

      const existing = db.select()
        .from(schema.retrievalRecords)
        .where(eq(schema.retrievalRecords.id, recordId))
        .get();
      if (existing?.contentHash === contentHash) continue;

      const chunks = chunkText(text);
      const embeddedChunks = await Promise.all(
        chunks.map(async (chunk, i) => ({
          chunkId: `project_doc:${relPath}:${i}` as const,
          text: chunk,
          embedding: await embedText(chunk, cfg.retrieval_ollama_url, cfg.retrieval_embedding_model, {
            project: schedId,
            sourceKind: 'project_doc',
          }),
          project: schedId,
          sourceKind: 'project_doc' as SourceKind,
          sourceId: relPath,
          chunkIndex: i,
          metadata: { filePath: relPath },
        }))
      );
      backend.upsertChunks(embeddedChunks);
      totalChunks += chunks.length;

      db.insert(schema.retrievalRecords)
        .values({
          id: recordId,
          project: schedId,
          sourceKind: 'project_doc',
          sourceId: relPath,
          chunkCount: chunks.length,
          contentHash,
          indexedAt: Date.now() / 1000,
        })
        .onConflictDoUpdate({
          target: schema.retrievalRecords.id,
          set: { contentHash, indexedAt: Date.now() / 1000, chunkCount: chunks.length },
        })
        .run();
    }
  } catch (err) {
    console.error('[retrieval] reindex failed:', err);
    return NextResponse.json({ error: 'Reindex failed' }, { status: 500 });
  }

  return NextResponse.json({ chunks: totalChunks });
}
