import type Database from 'better-sqlite3';
import type { RetrievalBackend, RetrievalChunk, RetrievalResult, SourceKind } from './backend';

export class SqliteVecBackend implements RetrievalBackend {
  constructor(private readonly db: Database.Database) {}

  upsertChunks(chunks: RetrievalChunk[]): void {
    for (const chunk of chunks) {
      // Remove existing entry if present
      const existing = this.db
        .prepare<[string], { id: number; chunk_id: string }>('SELECT id, chunk_id FROM retrieval_chunks WHERE chunk_id = ?')
        .get(chunk.chunkId);
      if (existing) {
        // Find and delete the vec_chunks row by chunk_id aux column
        const vecRow = this.db
          .prepare<[string], { rowid: number }>('SELECT rowid FROM vec_chunks WHERE chunk_id = ?')
          .get(chunk.chunkId);
        if (vecRow) {
          this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(vecRow.rowid);
        }
        this.db.prepare('DELETE FROM retrieval_chunks WHERE chunk_id = ?').run(chunk.chunkId);
      }

      this.db.prepare(
        `INSERT INTO retrieval_chunks
           (chunk_id, project, source_kind, source_id, chunk_index, text, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        chunk.chunkId, chunk.project, chunk.sourceKind,
        chunk.sourceId, chunk.chunkIndex, chunk.text,
        JSON.stringify(chunk.metadata)
      );

      this.db.prepare('INSERT INTO vec_chunks(embedding, chunk_id) VALUES (?, ?)').run(
        Buffer.from(new Float32Array(chunk.embedding).buffer),
        chunk.chunkId
      );
    }
  }

  search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): RetrievalResult[] {
    const knn = opts.limit * 10;
    const queryVec = Buffer.from(new Float32Array(opts.embedding).buffer);
    const rows = this.db
      .prepare<[Buffer, number], { rowid: number; distance: number; chunk_id: string }>(
        'SELECT rowid, distance, chunk_id FROM vec_chunks WHERE embedding MATCH ? AND k = ?'
      )
      .all(queryVec, knn);

    const results: RetrievalResult[] = [];
    for (const row of rows) {
      const chunk = this.db
        .prepare<[string], {
          project: string; source_kind: string; source_id: string;
          text: string; metadata: string;
        }>('SELECT project, source_kind, source_id, text, metadata FROM retrieval_chunks WHERE chunk_id = ?')
        .get(row.chunk_id);
      if (!chunk) continue;
      if (chunk.project !== opts.project) continue;
      if (opts.sourceKinds && !opts.sourceKinds.includes(chunk.source_kind as SourceKind)) continue;
      // sqlite-vec returns L2 distance; convert to approximate cosine similarity
      const score = Math.max(0, 1 - (row.distance * row.distance) / 2);
      results.push({
        text: chunk.text,
        sourceKind: chunk.source_kind as SourceKind,
        sourceId: chunk.source_id,
        score,
        metadata: JSON.parse(chunk.metadata) as Record<string, string>,
      });
      if (results.length >= opts.limit) break;
    }
    return results;
  }

  countProjectChunks(project: string, sourceKinds?: SourceKind[]): number {
    if (!sourceKinds || sourceKinds.length === 0) {
      const row = this.db.prepare<[string], { count: number }>(
        'SELECT count(*) AS count FROM retrieval_chunks WHERE project = ?'
      ).get(project);
      return row?.count ?? 0;
    }

    const placeholders = sourceKinds.map(() => '?').join(', ');
    const row = this.db.prepare<[string, ...string[]], { count: number }>(
      `SELECT count(*) AS count FROM retrieval_chunks WHERE project = ? AND source_kind IN (${placeholders})`
    ).get(project, ...sourceKinds);
    return row?.count ?? 0;
  }

  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): void {
    const rows = this.db
      .prepare<[string, string, string], { chunk_id: string }>(
        'SELECT chunk_id FROM retrieval_chunks WHERE project = ? AND source_kind = ? AND source_id = ?'
      )
      .all(project, sourceKind, sourceId);
    for (const row of rows) {
      const vecRow = this.db
        .prepare<[string], { rowid: number }>('SELECT rowid FROM vec_chunks WHERE chunk_id = ?')
        .get(row.chunk_id);
      if (vecRow) {
        this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(vecRow.rowid);
      }
    }
    this.db
      .prepare('DELETE FROM retrieval_chunks WHERE project = ? AND source_kind = ? AND source_id = ?')
      .run(project, sourceKind, sourceId);
  }

  deleteProject(project: string): void {
    const rows = this.db
      .prepare<[string], { chunk_id: string }>('SELECT chunk_id FROM retrieval_chunks WHERE project = ?')
      .all(project);
    for (const row of rows) {
      const vecRow = this.db
        .prepare<[string], { rowid: number }>('SELECT rowid FROM vec_chunks WHERE chunk_id = ?')
        .get(row.chunk_id);
      if (vecRow) {
        this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(vecRow.rowid);
      }
    }
    this.db.prepare('DELETE FROM retrieval_chunks WHERE project = ?').run(project);
  }
}
