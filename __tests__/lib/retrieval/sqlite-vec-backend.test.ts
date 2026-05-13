import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { isSqliteVecAvailable, loadSqliteVec } from '@/lib/db/sqlite-vec';
import type { RetrievalChunk } from '@/lib/agents/retrieval/backend';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  if (!loadSqliteVec(db)) {
    throw new Error('sqlite-vec is not available in this environment');
  }
  db.prepare(
    'CREATE TABLE IF NOT EXISTS retrieval_chunks (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'chunk_id TEXT NOT NULL UNIQUE,' +
    'project TEXT NOT NULL,' +
    'source_kind TEXT NOT NULL,' +
    'source_id TEXT NOT NULL,' +
    'chunk_index INTEGER NOT NULL,' +
    'text TEXT NOT NULL,' +
    'metadata TEXT NOT NULL' +
    ')'
  ).run();
  db.prepare(
    'CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding FLOAT[768], +chunk_id TEXT)'
  ).run();
  return db;
}

const describeIfSqliteVec = isSqliteVecAvailable() ? describe : describe.skip;

function makeChunk(overrides: Partial<RetrievalChunk> = {}): RetrievalChunk {
  return {
    chunkId: 'agent_run:job-1:0',
    text: 'auth middleware review passed, no issues found',
    embedding: Array.from({ length: 768 }, () => Math.random()),
    project: 'myproject',
    sourceKind: 'agent_run',
    sourceId: 'job-1',
    chunkIndex: 0,
    metadata: { agentName: 'review-agent' },
    ...overrides,
  };
}

describeIfSqliteVec('SqliteVecBackend', () => {
  let db: ReturnType<typeof createTestDb>;
  let backend: SqliteVecBackend;

  beforeEach(() => {
    db = createTestDb();
    backend = new SqliteVecBackend(db);
  });

  it('upserts a chunk and retrieves it by similarity', () => {
    const chunk = makeChunk();
    backend.upsertChunks([chunk]);

    const results = backend.search({ embedding: chunk.embedding, project: 'myproject', limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe(chunk.text);
    expect(results[0].score).toBeGreaterThan(0.99);
    expect(results[0].sourceKind).toBe('agent_run');
    expect(results[0].metadata.agentName).toBe('review-agent');
  });

  it('is idempotent — upserting the same chunkId twice does not duplicate', () => {
    const chunk = makeChunk();
    backend.upsertChunks([chunk]);
    backend.upsertChunks([chunk]);

    const results = backend.search({ embedding: chunk.embedding, project: 'myproject', limit: 10 });
    expect(results).toHaveLength(1);
  });

  it('enforces project isolation — project A results never appear for project B', () => {
    const chunkA = makeChunk({ project: 'projectA', chunkId: 'agent_run:job-a:0' });
    const chunkB = makeChunk({ project: 'projectB', chunkId: 'agent_run:job-b:0', embedding: [...chunkA.embedding] });
    backend.upsertChunks([chunkA, chunkB]);

    const resultsA = backend.search({ embedding: chunkA.embedding, project: 'projectA', limit: 10 });
    const resultsB = backend.search({ embedding: chunkA.embedding, project: 'projectB', limit: 10 });

    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].text).toBe(chunkA.text);
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].text).toBe(chunkB.text);
  });

  it('deleteSource removes all chunks for that sourceId', () => {
    backend.upsertChunks([
      makeChunk({ chunkId: 'agent_run:job-1:0', sourceId: 'job-1' }),
      makeChunk({ chunkId: 'agent_run:job-1:1', sourceId: 'job-1', chunkIndex: 1 }),
      makeChunk({ chunkId: 'agent_run:job-2:0', sourceId: 'job-2' }),
    ]);
    backend.deleteSource('myproject', 'agent_run', 'job-1');

    const results = backend.search({ embedding: makeChunk().embedding, project: 'myproject', limit: 10 });
    expect(results.every(r => r.sourceId !== 'job-1')).toBe(true);
  });

  it('deleteProject removes all chunks for that project', () => {
    backend.upsertChunks([
      makeChunk({ project: 'myproject', chunkId: 'agent_run:j1:0' }),
      makeChunk({ project: 'other', chunkId: 'agent_run:j2:0' }),
    ]);
    backend.deleteProject('myproject');

    const results = backend.search({ embedding: makeChunk().embedding, project: 'myproject', limit: 10 });
    expect(results).toHaveLength(0);
  });

  it('filters by sourceKinds when provided', () => {
    const runChunk = makeChunk({ chunkId: 'agent_run:j1:0', sourceKind: 'agent_run' });
    const docChunk = makeChunk({
      chunkId: 'project_doc:readme:0',
      sourceKind: 'project_doc',
      sourceId: 'README.md',
      embedding: [...runChunk.embedding],
    });
    backend.upsertChunks([runChunk, docChunk]);

    const results = backend.search({
      embedding: runChunk.embedding,
      project: 'myproject',
      limit: 10,
      sourceKinds: ['agent_run'],
    });
    expect(results.every(r => r.sourceKind === 'agent_run')).toBe(true);
  });

  it('counts chunks for a project and optional source filters', () => {
    backend.upsertChunks([
      makeChunk({ chunkId: 'agent_run:j1:0', sourceKind: 'agent_run' }),
      makeChunk({ chunkId: 'project_doc:readme:0', sourceKind: 'project_doc', sourceId: 'README.md' }),
      makeChunk({ chunkId: 'project_doc:readme:1', sourceKind: 'project_doc', sourceId: 'README.md', chunkIndex: 1 }),
      makeChunk({ chunkId: 'agent_run:other:0', project: 'other' }),
    ]);

    expect(backend.countProjectChunks('myproject')).toBe(3);
    expect(backend.countProjectChunks('myproject', ['project_doc'])).toBe(2);
    expect(backend.countProjectChunks('other')).toBe(1);
  });

  it('removes trailing stale chunks when a source is replaced with fewer chunks', () => {
    backend.upsertChunks([
      makeChunk({ chunkId: 'project_doc:README.md:0', sourceKind: 'project_doc', sourceId: 'README.md' }),
      makeChunk({ chunkId: 'project_doc:README.md:1', sourceKind: 'project_doc', sourceId: 'README.md', chunkIndex: 1 }),
      makeChunk({ chunkId: 'project_doc:README.md:2', sourceKind: 'project_doc', sourceId: 'README.md', chunkIndex: 2 }),
    ]);

    backend.deleteSource('myproject', 'project_doc', 'README.md');
    backend.upsertChunks([
      makeChunk({ chunkId: 'project_doc:README.md:0', sourceKind: 'project_doc', sourceId: 'README.md' }),
      makeChunk({ chunkId: 'project_doc:README.md:1', sourceKind: 'project_doc', sourceId: 'README.md', chunkIndex: 1 }),
    ]);

    expect(backend.countProjectChunks('myproject', ['project_doc'])).toBe(2);
    expect(
      db.prepare<[string], { chunk_id: string } | undefined>(
        'SELECT chunk_id FROM retrieval_chunks WHERE chunk_id = ?'
      ).get('project_doc:README.md:2')
    ).toBeUndefined();
    expect(
      db.prepare<[string], { rowid: number } | undefined>(
        'SELECT rowid FROM vec_chunks WHERE chunk_id = ?'
      ).get('project_doc:README.md:2')
    ).toBeUndefined();
  });
});
