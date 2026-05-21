import { eq, and, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import type { RetrievalBackend, RetrievalChunk, RetrievalResult, SourceKind } from './backend';

export class PgvectorBackend implements RetrievalBackend {
  async upsertChunks(chunks: RetrievalChunk[]): Promise<void> {
    for (const chunk of chunks) {
      await db.insert(schema.retrievalChunks)
        .values({
          chunkId: chunk.chunkId,
          project: chunk.project,
          sourceKind: chunk.sourceKind,
          sourceId: chunk.sourceId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          metadata: JSON.stringify(chunk.metadata),
          embedding: chunk.embedding,
        })
        .onConflictDoUpdate({
          target: schema.retrievalChunks.chunkId,
          set: {
            text: chunk.text,
            metadata: JSON.stringify(chunk.metadata),
            embedding: chunk.embedding,
            chunkIndex: chunk.chunkIndex,
          },
        })
        .execute();
    }
  }

  async search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): Promise<RetrievalResult[]> {
    // Fetch only what the caller asked for: nothing here re-ranks or
    // applies a score filter before the slice. The retriever's
    // score-threshold filter runs on whatever this function returns and
    // wouldn't benefit from extra candidates beyond `limit`.
    const embeddingStr = `[${opts.embedding.join(',')}]`;

    // Cosine distance search using pgvector <=> operator
    const rows = await db.execute<{
      chunk_id: string;
      project: string;
      source_kind: string;
      source_id: string;
      text: string;
      metadata: string;
      distance: number;
    }>(sql`
      SELECT chunk_id, project, source_kind, source_id, text, metadata,
             embedding <=> ${embeddingStr}::vector AS distance
      FROM retrieval_chunks
      WHERE project = ${opts.project}
        ${opts.sourceKinds && opts.sourceKinds.length > 0
          ? sql`AND source_kind = ANY(${opts.sourceKinds})`
          : sql``}
        AND embedding IS NOT NULL
      ORDER BY distance
      LIMIT ${opts.limit}
    `);

    const results: RetrievalResult[] = [];
    for (const row of rows.rows) {
      // Cosine distance (0=identical, 2=opposite) → similarity score (0–1)
      const score = Math.max(0, 1 - row.distance);
      results.push({
        text: row.text,
        sourceKind: row.source_kind as SourceKind,
        sourceId: row.source_id,
        score,
        metadata: JSON.parse(row.metadata) as Record<string, string>,
      });
    }
    return results;
  }

  async countProjectChunks(project: string, sourceKinds?: SourceKind[]): Promise<number> {
    if (!sourceKinds || sourceKinds.length === 0) {
      const rows = await db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM retrieval_chunks WHERE project = ${project}
      `);
      return parseInt(rows.rows[0]?.count ?? '0', 10);
    }

    const rows = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.retrievalChunks)
      .where(and(
        eq(schema.retrievalChunks.project, project),
        inArray(schema.retrievalChunks.sourceKind, sourceKinds),
      ));
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  async deleteSource(project: string, sourceKind: SourceKind, sourceId: string): Promise<void> {
    await db.delete(schema.retrievalChunks)
      .where(and(
        eq(schema.retrievalChunks.project, project),
        eq(schema.retrievalChunks.sourceKind, sourceKind),
        eq(schema.retrievalChunks.sourceId, sourceId),
      ))
      .execute();
  }

  async deleteProject(project: string): Promise<void> {
    await db.delete(schema.retrievalChunks)
      .where(eq(schema.retrievalChunks.project, project))
      .execute();
  }
}
