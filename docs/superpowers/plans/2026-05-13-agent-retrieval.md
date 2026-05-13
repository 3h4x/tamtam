# Agent Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a semantic retrieval layer that embeds agent run reports, project docs, and skills into sqlite-vec, then injects relevant context into agent prompts at run time via Ollama (`nomic-embed-text`).

**Architecture:** `lib/agents/retrieval/` contains a `RetrievalBackend` interface + sqlite-vec implementation, an Ollama HTTP embedder, a text chunker, an ingestion orchestrator, and a prompt-time retriever. Ingestion is triggered from `finalizeAgentRunReport` (runs) and skill save routes. Retrieval is injected in the agent run route before `withBasePrompt`. Ollama is managed by PM2.

**Tech Stack:** `sqlite-vec` (npm), `better-sqlite3` (existing), Ollama HTTP API, Drizzle ORM (existing), Next.js App Router (existing). Shell calls use `exec` from `lib/shared/shell.ts` (TamTam's safe wrapper around execFile — not raw child_process.exec).

**Spec:** `docs/superpowers/specs/2026-05-13-agent-retrieval-design.md`

---

## File Map

**Create:**
- `lib/agents/retrieval/backend.ts` — `RetrievalBackend` interface + shared types
- `lib/agents/retrieval/ollama-embedder.ts` — HTTP client for `POST /api/embed`
- `lib/agents/retrieval/chunker.ts` — character-based text chunker
- `lib/agents/retrieval/sqlite-vec-backend.ts` — sqlite-vec implementation of `RetrievalBackend`
- `lib/agents/retrieval/ingestion.ts` — orchestrates embed + upsert for all source kinds
- `lib/agents/retrieval/retriever.ts` — prompt-time retrieval + `## Retrieved Context` block
- `lib/agents/retrieval/ollama-lifecycle.ts` — PM2-managed Ollama startup
- `app/api/projects/[name]/retrieval/reindex/route.ts` — on-demand doc reindex endpoint
- `__tests__/lib/retrieval/chunker.test.ts`
- `__tests__/lib/retrieval/ollama-embedder.test.ts`
- `__tests__/lib/retrieval/sqlite-vec-backend.test.ts`
- `__tests__/lib/retrieval/ingestion.test.ts`
- `__tests__/lib/retrieval/retriever.test.ts`
- `__tests__/api/retrieval-reindex.test.ts`

**Modify:**
- `package.json` + `pnpm-lock.yaml` — add `sqlite-vec`
- `lib/db/schema.ts` — add `retrievalRecords`, `retrievalChunks` tables
- `lib/db/index.ts` — load sqlite-vec extension, bootstrap `vec_chunks` virtual table + new tables
- `lib/shared/config.ts` — add retrieval settings to `TamTamConfig`, `DEFAULTS`, `getSettings()`
- `lib/agents/agent-run-report.ts` — call `ingestAgentRun` from `finalizeAgentRunReport`
- `app/api/agents/[agentId]/run/route.ts` — inject `retrieveAgentContext` before `withBasePrompt`
- `instrumentation-node.ts` — call `ensureOllamaRunning` on boot
- `docs/SETTINGS.md` — document new setting keys

---

## Task 1: Install sqlite-vec

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the package**

```bash
pnpm add sqlite-vec
```

- [ ] **Step 2: Verify it loads with better-sqlite3**

```bash
node -e "
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
sqliteVec.load(db);
db.exec('CREATE VIRTUAL TABLE t USING vec0(v FLOAT[3])');
db.prepare('INSERT INTO t(rowid, v) VALUES (?, ?)').run(1, Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer));
const rows = db.prepare('SELECT rowid, distance FROM t WHERE v MATCH ? AND k = 1').all(Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer));
console.log(rows);
"
```

Expected: `[ { rowid: 1, distance: 0 } ]`

- [ ] **Step 3: Run pnpm audit**

```bash
pnpm audit
```

Expected: no new high-severity findings.

---

## Task 2: DB schema — retrieval_records and retrieval_chunks tables

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/index.ts`

- [ ] **Step 1: Add tables to schema.ts**

At the bottom of `lib/db/schema.ts`, add:

```typescript
export const retrievalRecords = sqliteTable('retrieval_records', {
  id: text('id').primaryKey(), // `${project}:${sourceKind}:${sourceId}`
  project: text('project').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  contentHash: text('content_hash').notNull(),
  indexedAt: real('indexed_at').notNull(),
});

export const retrievalChunks = sqliteTable('retrieval_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chunkId: text('chunk_id').notNull().unique(),
  project: text('project').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  metadata: text('metadata').notNull(),
});
```

- [ ] **Step 2: Add to lib/db/index.ts — import sqlite-vec and bootstrap**

Add import at the top of `lib/db/index.ts` after existing imports:

```typescript
import * as sqliteVec from 'sqlite-vec';
```

Add after `sqlite.pragma('foreign_keys = ON');`:

```typescript
// Load sqlite-vec vector extension (graceful degradation if unavailable)
try {
  sqliteVec.load(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_records (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retrieval_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding FLOAT[768]);
  `);
} catch (err) {
  console.warn('[db] sqlite-vec unavailable, retrieval disabled:', err);
}
```

- [ ] **Step 3: Generate and run migration**

```bash
pnpm db:generate && pnpm db:migrate
```

Expected: new migration file created and applied without error.

---

## Task 3: RetrievalBackend interface

**Files:**
- Create: `lib/agents/retrieval/backend.ts`

- [ ] **Step 1: Write the interface**

```typescript
// lib/agents/retrieval/backend.ts
export type SourceKind = 'agent_run' | 'project_doc' | 'skill';

export interface RetrievalChunk {
  chunkId: string;        // `${sourceKind}:${sourceId}:${chunkIndex}` — deterministic
  text: string;
  embedding: number[];    // 768-dim float32
  project: string;
  sourceKind: SourceKind;
  sourceId: string;
  chunkIndex: number;
  metadata: Record<string, string>;
}

export interface RetrievalResult {
  text: string;
  sourceKind: SourceKind;
  sourceId: string;
  score: number;          // 0-1, higher = more similar
  metadata: Record<string, string>;
}

export interface RetrievalBackend {
  upsertChunks(chunks: RetrievalChunk[]): void;
  search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): RetrievalResult[];
  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): void;
  deleteProject(project: string): void;
}
```

Note: methods are synchronous — better-sqlite3 is synchronous and sqlite-vec runs in-process.

---

## Task 4: ollama-embedder — TDD

**Files:**
- Create: `lib/agents/retrieval/ollama-embedder.ts`
- Create: `__tests__/lib/retrieval/ollama-embedder.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/retrieval/ollama-embedder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { embedText } from '@/lib/agents/retrieval/ollama-embedder';

beforeEach(() => { mockFetch.mockReset(); });

describe('embedText', () => {
  it('returns 768-dim vector on success', async () => {
    const vec = Array.from({ length: 768 }, (_, i) => i * 0.001);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [vec] }),
    });

    const result = await embedText('hello world', 'http://localhost:11434', 'nomic-embed-text');

    expect(result).toHaveLength(768);
    expect(result[0]).toBeCloseTo(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when Ollama returns non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(embedText('test', 'http://localhost:11434', 'nomic-embed-text'))
      .rejects.toThrow('503');
  });

  it('throws when fetch rejects (Ollama not running)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(embedText('test', 'http://localhost:11434', 'nomic-embed-text'))
      .rejects.toThrow('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/lib/retrieval/ollama-embedder.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement ollama-embedder.ts**

```typescript
// lib/agents/retrieval/ollama-embedder.ts
export async function embedText(
  text: string,
  ollamaUrl: string,
  model: string
): Promise<number[]> {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status}`);
  }
  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings[0];
}
```

- [ ] **Step 4: Run tests — confirm passing**

```bash
pnpm test __tests__/lib/retrieval/ollama-embedder.test.ts
```

Expected: 3 tests pass.

---

## Task 5: chunker — TDD

**Files:**
- Create: `lib/agents/retrieval/chunker.ts`
- Create: `__tests__/lib/retrieval/chunker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/retrieval/chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } from '@/lib/agents/retrieval/chunker';

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('hello world');
  });

  it('returns single chunk for empty string', () => {
    expect(chunkText('')).toEqual(['']);
  });

  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(CHUNK_SIZE + CHUNK_OVERLAP + 100);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBe(CHUNK_SIZE);
    }
  });

  it('adjacent chunks share CHUNK_OVERLAP characters', () => {
    const text = 'x'.repeat(CHUNK_SIZE * 2);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const tail = chunks[0].slice(-CHUNK_OVERLAP);
    const head = chunks[1].slice(0, CHUNK_OVERLAP);
    expect(tail).toBe(head);
  });

  it('covers entire input with no gaps', () => {
    const text = 'abc'.repeat(1000);
    const chunks = chunkText(text);
    let reconstructed = chunks[0];
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i].slice(CHUNK_OVERLAP);
    }
    expect(reconstructed).toBe(text);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/lib/retrieval/chunker.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement chunker.ts**

```typescript
// lib/agents/retrieval/chunker.ts
export const CHUNK_SIZE = 1800;   // ~512 tokens at ~3.5 chars/token
export const CHUNK_OVERLAP = 200;

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}
```

- [ ] **Step 4: Run tests — confirm passing**

```bash
pnpm test __tests__/lib/retrieval/chunker.test.ts
```

Expected: 5 tests pass.

---

## Task 6: sqlite-vec-backend — TDD

**Files:**
- Create: `lib/agents/retrieval/sqlite-vec-backend.ts`
- Create: `__tests__/lib/retrieval/sqlite-vec-backend.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/retrieval/sqlite-vec-backend.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import type { RetrievalChunk } from '@/lib/agents/retrieval/backend';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding FLOAT[768]);
  `);
  return db;
}

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

describe('SqliteVecBackend', () => {
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
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/lib/retrieval/sqlite-vec-backend.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement sqlite-vec-backend.ts**

```typescript
// lib/agents/retrieval/sqlite-vec-backend.ts
import type Database from 'better-sqlite3';
import type { RetrievalBackend, RetrievalChunk, RetrievalResult, SourceKind } from './backend';

export class SqliteVecBackend implements RetrievalBackend {
  constructor(private readonly db: Database.Database) {}

  upsertChunks(chunks: RetrievalChunk[]): void {
    for (const chunk of chunks) {
      const existing = this.db
        .prepare<[string], { id: number }>('SELECT id FROM retrieval_chunks WHERE chunk_id = ?')
        .get(chunk.chunkId);
      if (existing) {
        this.db.prepare('DELETE FROM retrieval_chunks WHERE chunk_id = ?').run(chunk.chunkId);
        this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(existing.id);
      }
      const info = this.db.prepare(
        `INSERT INTO retrieval_chunks
           (chunk_id, project, source_kind, source_id, chunk_index, text, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        chunk.chunkId, chunk.project, chunk.sourceKind,
        chunk.sourceId, chunk.chunkIndex, chunk.text,
        JSON.stringify(chunk.metadata)
      );
      this.db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)').run(
        Number(info.lastInsertRowid),
        Buffer.from(new Float32Array(chunk.embedding).buffer)
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
      .prepare<[Buffer, number], { rowid: number; distance: number }>(
        'SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?'
      )
      .all(queryVec, knn);

    const results: RetrievalResult[] = [];
    for (const row of rows) {
      const chunk = this.db
        .prepare<[number], {
          project: string; source_kind: string; source_id: string;
          text: string; metadata: string;
        }>('SELECT project, source_kind, source_id, text, metadata FROM retrieval_chunks WHERE id = ?')
        .get(row.rowid);
      if (!chunk) continue;
      if (chunk.project !== opts.project) continue;
      if (opts.sourceKinds && !opts.sourceKinds.includes(chunk.source_kind as SourceKind)) continue;
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

  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): void {
    const rows = this.db
      .prepare<[string, string, string], { id: number }>(
        'SELECT id FROM retrieval_chunks WHERE project = ? AND source_kind = ? AND source_id = ?'
      )
      .all(project, sourceKind, sourceId);
    for (const row of rows) {
      this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(row.id);
    }
    this.db
      .prepare('DELETE FROM retrieval_chunks WHERE project = ? AND source_kind = ? AND source_id = ?')
      .run(project, sourceKind, sourceId);
  }

  deleteProject(project: string): void {
    const rows = this.db
      .prepare<[string], { id: number }>('SELECT id FROM retrieval_chunks WHERE project = ?')
      .all(project);
    for (const row of rows) {
      this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(row.id);
    }
    this.db.prepare('DELETE FROM retrieval_chunks WHERE project = ?').run(project);
  }
}
```

**Score note:** sqlite-vec returns Euclidean distance. The formula `1 - d²/2` gives an approximate cosine similarity. If the 0.8 threshold proves too aggressive in practice, lower `retrieval_score_threshold` to 0.5–0.6.

- [ ] **Step 4: Run tests — confirm passing**

```bash
pnpm test __tests__/lib/retrieval/sqlite-vec-backend.test.ts
```

Expected: 6 tests pass.

---

## Task 7: Add retrieval settings to TamTamConfig

**Files:**
- Modify: `lib/shared/config.ts`

- [ ] **Step 1: Add to TamTamConfig interface** (inside the interface block around line 16)

```typescript
  retrieval_enabled: boolean;
  retrieval_ollama_url: string;
  retrieval_embedding_model: string;
  retrieval_context_limit: number;
  retrieval_score_threshold: number;
  retrieval_manage_ollama: boolean;
```

- [ ] **Step 2: Add to DEFAULTS** (inside the DEFAULTS object around line 81)

```typescript
  retrieval_enabled: false,
  retrieval_ollama_url: 'http://localhost:11434',
  retrieval_embedding_model: 'nomic-embed-text',
  retrieval_context_limit: 5,
  retrieval_score_threshold: 0.8,
  retrieval_manage_ollama: true,
```

- [ ] **Step 3: Add to getSettings() config block**

```typescript
  retrieval_enabled: map.retrieval_enabled === 'true',
  retrieval_ollama_url: map.retrieval_ollama_url ?? DEFAULTS.retrieval_ollama_url,
  retrieval_embedding_model: map.retrieval_embedding_model ?? DEFAULTS.retrieval_embedding_model,
  retrieval_context_limit: parseIntOr(map.retrieval_context_limit, DEFAULTS.retrieval_context_limit),
  retrieval_score_threshold: (() => {
    const v = parseFloat(map.retrieval_score_threshold ?? '');
    return Number.isFinite(v) ? v : DEFAULTS.retrieval_score_threshold;
  })(),
  retrieval_manage_ollama: map.retrieval_manage_ollama !== 'false',
```

- [ ] **Step 4: Type-check**

```bash
pnpm type-check
```

Expected: no errors.

---

## Task 8: ingestion — TDD

**Files:**
- Create: `lib/agents/retrieval/ingestion.ts`
- Create: `__tests__/lib/retrieval/ingestion.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/retrieval/ingestion.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievalChunk } from '@/lib/agents/retrieval/backend';

const mockEmbed = vi.fn().mockResolvedValue(Array(768).fill(0.1));
vi.mock('@/lib/agents/retrieval/ollama-embedder', () => ({ embedText: mockEmbed }));

const mockBackend = {
  upsertChunks: vi.fn(),
  search: vi.fn(),
  deleteSource: vi.fn(),
  deleteProject: vi.fn(),
};

describe('ingestAgentRun', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('embeds the run summary and calls upsertChunks', async () => {
    const { ingestAgentRun } = await import('@/lib/agents/retrieval/ingestion');

    await ingestAgentRun({
      backend: mockBackend,
      project: 'myproject',
      jobId: 'job-1',
      agentId: 'agent-1',
      agentName: 'review-agent',
      workSummary: 'No issues found in auth middleware',
      modifiedFiles: ['lib/auth.ts'],
      exitCode: 0,
      completedAt: 1234567890,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      existingHash: null,
    });

    expect(mockEmbed).toHaveBeenCalledWith(
      expect.stringContaining('No issues found'),
      'http://localhost:11434',
      'nomic-embed-text'
    );
    expect(mockBackend.upsertChunks).toHaveBeenCalledOnce();
    const [chunks] = mockBackend.upsertChunks.mock.calls[0] as [RetrievalChunk[]];
    expect(chunks[0].chunkId).toBe('agent_run:job-1:0');
    expect(chunks[0].project).toBe('myproject');
    expect(chunks[0].sourceKind).toBe('agent_run');
    expect(chunks[0].metadata.agentName).toBe('review-agent');
  });

  it('skips embed + upsert when existingHash matches', async () => {
    vi.resetModules();
    const { ingestAgentRun, hashContent } = await import('@/lib/agents/retrieval/ingestion');
    const text = 'All clear\n\nFiles: none\nAgent: review-agent\nExit: 0';
    const hash = hashContent(text);

    await ingestAgentRun({
      backend: mockBackend,
      project: 'myproject',
      jobId: 'job-1',
      agentId: 'agent-1',
      agentName: 'review-agent',
      workSummary: 'All clear',
      modifiedFiles: [],
      exitCode: 0,
      completedAt: 1234567890,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      existingHash: hash,
    });

    expect(mockBackend.upsertChunks).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('does not throw when embedText rejects (best-effort)', async () => {
    vi.resetModules();
    const embedMod = await import('@/lib/agents/retrieval/ollama-embedder');
    vi.spyOn(embedMod, 'embedText').mockRejectedValueOnce(new Error('Ollama down'));

    const { ingestAgentRun } = await import('@/lib/agents/retrieval/ingestion');

    await expect(ingestAgentRun({
      backend: mockBackend,
      project: 'myproject',
      jobId: 'job-1',
      agentId: 'agent-1',
      agentName: 'review-agent',
      workSummary: 'summary',
      modifiedFiles: [],
      exitCode: 0,
      completedAt: 1234567890,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      existingHash: null,
    })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/lib/retrieval/ingestion.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement ingestion.ts**

```typescript
// lib/agents/retrieval/ingestion.ts
import { createHash } from 'crypto';
import { chunkText } from './chunker';
import { embedText } from './ollama-embedder';
import type { RetrievalBackend, SourceKind } from './backend';

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildRunText(opts: {
  workSummary: string;
  modifiedFiles: string[];
  agentName: string;
  exitCode: number;
}): string {
  const files = opts.modifiedFiles.length > 0 ? opts.modifiedFiles.join(', ') : 'none';
  return `${opts.workSummary}\n\nFiles: ${files}\nAgent: ${opts.agentName}\nExit: ${opts.exitCode}`;
}

export interface IngestAgentRunOpts {
  backend: RetrievalBackend;
  project: string;
  jobId: string;
  agentId: string;
  agentName: string;
  workSummary: string;
  modifiedFiles: string[];
  exitCode: number;
  completedAt: number;
  ollamaUrl: string;
  embeddingModel: string;
  existingHash: string | null;
}

export async function ingestAgentRun(
  opts: IngestAgentRunOpts
): Promise<{ contentHash: string; skipped: boolean }> {
  const text = buildRunText({
    workSummary: opts.workSummary,
    modifiedFiles: opts.modifiedFiles,
    agentName: opts.agentName,
    exitCode: opts.exitCode,
  });
  const contentHash = hashContent(text);

  if (opts.existingHash === contentHash) {
    return { contentHash, skipped: true };
  }

  try {
    const chunks = chunkText(text);
    const embeddedChunks = await Promise.all(
      chunks.map(async (chunk, i) => ({
        chunkId: `agent_run:${opts.jobId}:${i}` as const,
        text: chunk,
        embedding: await embedText(chunk, opts.ollamaUrl, opts.embeddingModel),
        project: opts.project,
        sourceKind: 'agent_run' as SourceKind,
        sourceId: opts.jobId,
        chunkIndex: i,
        metadata: {
          agentId: opts.agentId,
          agentName: opts.agentName,
          jobId: opts.jobId,
          exitCode: String(opts.exitCode),
          completedAt: String(opts.completedAt),
        },
      }))
    );
    opts.backend.upsertChunks(embeddedChunks);
  } catch (err) {
    console.warn('[retrieval] ingestAgentRun failed (best-effort):', err);
  }

  return { contentHash, skipped: false };
}
```

- [ ] **Step 4: Run tests — confirm passing**

```bash
pnpm test __tests__/lib/retrieval/ingestion.test.ts
```

Expected: 3 tests pass.

---

## Task 9: retriever — TDD

**Files:**
- Create: `lib/agents/retrieval/retriever.ts`
- Create: `__tests__/lib/retrieval/retriever.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/lib/retrieval/retriever.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievalResult } from '@/lib/agents/retrieval/backend';

const mockEmbed = vi.fn().mockResolvedValue(Array(768).fill(0.1));
vi.mock('@/lib/agents/retrieval/ollama-embedder', () => ({ embedText: mockEmbed }));

const mockSearch = vi.fn();
const mockBackend = {
  search: mockSearch,
  upsertChunks: vi.fn(),
  deleteSource: vi.fn(),
  deleteProject: vi.fn(),
};

import { buildRetrievedContextBlock, retrieveAgentContext } from '@/lib/agents/retrieval/retriever';

describe('buildRetrievedContextBlock', () => {
  it('returns null for empty results', () => {
    expect(buildRetrievedContextBlock([])).toBeNull();
  });

  it('formats agent_run result', () => {
    const result: RetrievalResult = {
      text: 'Auth middleware reviewed, all clear',
      sourceKind: 'agent_run',
      sourceId: 'job-1',
      score: 0.92,
      metadata: { agentName: 'review-agent' },
    };
    const block = buildRetrievedContextBlock([result]);
    expect(block).toContain('## Retrieved Context');
    expect(block).toContain('agent_run');
    expect(block).toContain('review-agent');
    expect(block).toContain('Auth middleware reviewed');
  });

  it('formats project_doc result', () => {
    const result: RetrievalResult = {
      text: 'Fix loop cap is 3 iterations',
      sourceKind: 'project_doc',
      sourceId: 'docs/PIPELINE.md',
      score: 0.85,
      metadata: { filePath: 'docs/PIPELINE.md' },
    };
    const block = buildRetrievedContextBlock([result]);
    expect(block).toContain('project_doc');
    expect(block).toContain('docs/PIPELINE.md');
    expect(block).toContain('Fix loop cap');
  });
});

describe('retrieveAgentContext', () => {
  beforeEach(() => { mockSearch.mockReset(); mockEmbed.mockResolvedValue(Array(768).fill(0.1)); });

  it('returns null when all results are below threshold', async () => {
    mockSearch.mockReturnValue([
      { text: 'irrelevant', sourceKind: 'agent_run', sourceId: 'j1', score: 0.3, metadata: {} },
    ]);
    const result = await retrieveAgentContext({
      backend: mockBackend,
      project: 'myproject',
      taskPrompt: 'review auth',
      limit: 5,
      scoreThreshold: 0.8,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });
    expect(result).toBeNull();
  });

  it('returns formatted block when results exceed threshold', async () => {
    mockSearch.mockReturnValue([
      { text: 'Auth reviewed OK', sourceKind: 'agent_run', sourceId: 'j1', score: 0.9, metadata: { agentName: 'review' } },
    ]);
    const result = await retrieveAgentContext({
      backend: mockBackend,
      project: 'myproject',
      taskPrompt: 'review auth',
      limit: 5,
      scoreThreshold: 0.8,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });
    expect(result).toContain('## Retrieved Context');
    expect(result).toContain('Auth reviewed OK');
  });

  it('returns null when embedText throws (Ollama unreachable)', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await retrieveAgentContext({
      backend: mockBackend,
      project: 'myproject',
      taskPrompt: 'review',
      limit: 5,
      scoreThreshold: 0.8,
      ollamaUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/lib/retrieval/retriever.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement retriever.ts**

```typescript
// lib/agents/retrieval/retriever.ts
import { embedText } from './ollama-embedder';
import type { RetrievalBackend, RetrievalResult } from './backend';

export function buildRetrievedContextBlock(results: RetrievalResult[]): string | null {
  if (results.length === 0) return null;

  const lines = results.map((r) => {
    const label =
      r.sourceKind === 'agent_run'
        ? `agent_run · ${r.metadata.agentName ?? r.sourceId}`
        : r.sourceKind === 'project_doc'
        ? `project_doc · ${r.metadata.filePath ?? r.sourceId}`
        : `skill · ${r.metadata.skillTitle ?? r.sourceId}`;
    return `[${label}]\n${r.text}`;
  });

  return [
    '## Retrieved Context',
    'The following was retrieved from past runs and project knowledge.',
    'Use it to avoid repeating work and stay consistent with prior decisions.',
    '',
    ...lines,
  ].join('\n');
}

export interface RetrieveAgentContextOpts {
  backend: RetrievalBackend;
  project: string;
  taskPrompt: string;
  limit: number;
  scoreThreshold: number;
  ollamaUrl: string;
  embeddingModel: string;
}

export async function retrieveAgentContext(opts: RetrieveAgentContextOpts): Promise<string | null> {
  try {
    const embedding = await embedText(opts.taskPrompt, opts.ollamaUrl, opts.embeddingModel);
    const results = opts.backend.search({ embedding, project: opts.project, limit: opts.limit });
    const above = results.filter((r) => r.score >= opts.scoreThreshold);
    return buildRetrievedContextBlock(above);
  } catch (err) {
    console.warn('[retrieval] retrieveAgentContext failed (best-effort):', err);
    return null;
  }
}
```

- [ ] **Step 4: Run tests — confirm passing**

```bash
pnpm test __tests__/lib/retrieval/retriever.test.ts
```

Expected: 5 tests pass.

---

## Task 10: Wire ingestion into finalizeAgentRunReport

**Files:**
- Modify: `lib/agents/agent-run-report.ts`

- [ ] **Step 1: Add imports at the top of agent-run-report.ts**

```typescript
import { getSettings } from '@/lib/shared/config';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { ingestAgentRun, hashContent } from '@/lib/agents/retrieval/ingestion';
```

- [ ] **Step 2: Find the raw sqlite instance**

Check `lib/db/index.ts` — the `sqlite` variable is the raw `better-sqlite3` instance. Export it:

```typescript
// At the bottom of lib/db/index.ts, add:
export { sqlite };
```

Then import in agent-run-report.ts:

```typescript
import { db, schema, sqlite } from '@/lib/db';
```

- [ ] **Step 3: Add ingestion call at the end of finalizeAgentRunReport**

At the very end of `finalizeAgentRunReport`, after `if (isAgent) maybeRecommendSchedule(...)`:

```typescript
  // Best-effort: index completed run for future retrieval (fire-and-forget)
  void (async () => {
    try {
      const cfg = getSettings();
      if (!cfg.retrieval_enabled || !job.workSummary) return;

      const recordId = `${job.project}:agent_run:${job.id}`;
      const existing = db.select()
        .from(schema.retrievalRecords)
        .where(eq(schema.retrievalRecords.id, recordId))
        .get();

      const backend = new SqliteVecBackend(sqlite);
      const files: string[] = job.modifiedFiles
        ? (JSON.parse(job.modifiedFiles) as { path: string }[]).map((f) => f.path)
        : [];

      const { contentHash, skipped } = await ingestAgentRun({
        backend,
        project: job.project,
        jobId: job.id,
        agentId: ctx.agent?.id ?? job.id,
        agentName: ctx.agent?.name ?? job.kind.replace(/^agent:/, ''),
        workSummary: job.workSummary,
        modifiedFiles: files,
        exitCode: job.exitCode ?? -1,
        completedAt: job.finishedAt ?? Date.now() / 1000,
        ollamaUrl: cfg.retrieval_ollama_url,
        embeddingModel: cfg.retrieval_embedding_model,
        existingHash: existing?.contentHash ?? null,
      });

      if (!skipped) {
        db.insert(schema.retrievalRecords)
          .values({
            id: recordId,
            project: job.project,
            sourceKind: 'agent_run',
            sourceId: job.id,
            chunkCount: 1,
            contentHash,
            indexedAt: Date.now() / 1000,
          })
          .onConflictDoUpdate({
            target: schema.retrievalRecords.id,
            set: { contentHash, indexedAt: Date.now() / 1000, chunkCount: 1 },
          })
          .run();
      }
    } catch (err) {
      console.warn('[retrieval] agent run ingestion failed:', err);
    }
  })();
```

- [ ] **Step 4: Type-check and test**

```bash
pnpm type-check && pnpm test
```

Expected: no type errors, all tests pass.

---

## Task 11: Wire retrieval into agent run route

**Files:**
- Modify: `app/api/agents/[agentId]/run/route.ts`

- [ ] **Step 1: Add imports** (at the top of the file)

```typescript
import { sqlite } from '@/lib/db';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { retrieveAgentContext } from '@/lib/agents/retrieval/retriever';
```

- [ ] **Step 2: Find where getSettings() is called in this route**

Search the file for `getSettings()` or `cfg`. If it already assigns `const cfg = getSettings();`, reuse that variable. If not, the retrieval block will call `getSettings()` inline.

- [ ] **Step 3: Inject retrieval before fullPrompt** (around line 566)

Replace:

```typescript
  const corePrompt = systemPrompt && taskPrompt
    ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
    : (systemPrompt || taskPrompt);
  const fullPrompt = withBasePrompt(`${corePrompt}\n\n---\n\n${memoryBlock}`, { projectPath: projPath, provider });
```

With:

```typescript
  const corePrompt = systemPrompt && taskPrompt
    ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
    : (systemPrompt || taskPrompt);

  let retrievedContext: string | null = null;
  if (cfg.retrieval_enabled && taskPrompt) {
    retrievedContext = await retrieveAgentContext({
      backend: new SqliteVecBackend(sqlite),
      project: agent.project,
      taskPrompt,
      limit: cfg.retrieval_context_limit,
      scoreThreshold: cfg.retrieval_score_threshold,
      ollamaUrl: cfg.retrieval_ollama_url,
      embeddingModel: cfg.retrieval_embedding_model,
    });
  }

  const promptWithRetrieval = retrievedContext
    ? `${retrievedContext}\n\n---\n\n${corePrompt}`
    : corePrompt;
  const fullPrompt = withBasePrompt(`${promptWithRetrieval}\n\n---\n\n${memoryBlock}`, { projectPath: projPath, provider });
```

If `cfg` isn't already in scope, add `const cfg = getSettings();` above this block.

- [ ] **Step 4: Type-check and test**

```bash
pnpm type-check && pnpm test
```

Expected: no type errors, all tests pass.

---

## Task 12: Reindex API route + tests

**Files:**
- Create: `app/api/projects/[name]/retrieval/reindex/route.ts`
- Create: `__tests__/api/retrieval-reindex.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// __tests__/api/retrieval-reindex.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn().mockReturnValue({
    retrieval_enabled: true,
    retrieval_ollama_url: 'http://localhost:11434',
    retrieval_embedding_model: 'nomic-embed-text',
  }),
}));

vi.mock('@/lib/agents/retrieval/ollama-embedder', () => ({
  embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
}));

const mockUpsert = vi.fn();
vi.mock('@/lib/agents/retrieval/sqlite-vec-backend', () => ({
  SqliteVecBackend: vi.fn().mockImplementation(() => ({
    upsertChunks: mockUpsert,
    search: vi.fn(),
    deleteSource: vi.fn(),
    deleteProject: vi.fn(),
  })),
}));

vi.mock('@/lib/db', () => ({
  sqlite: {},
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }) }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    }),
  },
  schema: { retrievalRecords: {} },
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: vi.fn().mockReturnValue('/tmp/workspace/myproject'),
}));

vi.mock('glob', () => ({ globSync: vi.fn().mockReturnValue(['/tmp/workspace/myproject/README.md']) }));
vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('# README\n\nProject docs here.'),
}));

describe('POST /api/projects/[name]/retrieval/reindex', () => {
  it('returns 400 when retrieval is disabled', async () => {
    vi.resetModules();
    const { getSettings } = await import('@/lib/shared/config');
    vi.mocked(getSettings).mockReturnValueOnce({ retrieval_enabled: false } as ReturnType<typeof getSettings>);
    const { POST } = await import('@/app/api/projects/[name]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ name: 'myproject' }) });
    expect(res.status).toBe(400);
  });

  it('returns 200 with chunk count on success', async () => {
    const { POST } = await import('@/app/api/projects/[name]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ name: 'myproject' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { chunks: number };
    expect(typeof body.chunks).toBe('number');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm test __tests__/api/retrieval-reindex.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Implement reindex route**

```typescript
// app/api/projects/[name]/retrieval/reindex/route.ts
import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { globSync } from 'glob';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { db, schema, sqlite } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { SqliteVecBackend } from '@/lib/agents/retrieval/sqlite-vec-backend';
import { embedText } from '@/lib/agents/retrieval/ollama-embedder';
import { chunkText } from '@/lib/agents/retrieval/chunker';
import { hashContent } from '@/lib/agents/retrieval/ingestion';
import type { SourceKind } from '@/lib/agents/retrieval/backend';

const DOC_GLOBS = ['CLAUDE.md', 'README.md', 'docs/**/*.md', '.tamtam/agents/*.md'];

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await params;
  const cfg = getSettings();

  if (!cfg.retrieval_enabled) {
    return NextResponse.json({ error: 'Retrieval is disabled' }, { status: 400 });
  }

  const projectPath = resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const backend = new SqliteVecBackend(sqlite);
  let totalChunks = 0;

  try {
    const files = DOC_GLOBS.flatMap((pattern) =>
      globSync(/*turbopackIgnore: true*/ pattern, {
        cwd: /*turbopackIgnore: true*/ projectPath,
        absolute: true,
        nodir: true,
      })
    );

    for (const filePath of files) {
      if (!existsSync(/*turbopackIgnore: true*/ filePath)) continue;
      const text = readFileSync(/*turbopackIgnore: true*/ filePath, 'utf-8');
      const relPath = filePath.replace(projectPath + '/', '');
      const contentHash = hashContent(text);
      const recordId = `${name}:project_doc:${relPath}`;

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
          embedding: await embedText(chunk, cfg.retrieval_ollama_url, cfg.retrieval_embedding_model),
          project: name,
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
          project: name,
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
```

- [ ] **Step 4: Run tests**

```bash
pnpm test __tests__/api/retrieval-reindex.test.ts
```

Expected: 2 tests pass.

---

## Task 13: Ollama lifecycle — PM2

**Files:**
- Create: `lib/agents/retrieval/ollama-lifecycle.ts`
- Modify: `instrumentation-node.ts`

- [ ] **Step 1: Implement ollama-lifecycle.ts**

All shell calls go through `lib/shared/shell.ts` `exec` — TamTam's safe wrapper around execFile.

```typescript
// lib/agents/retrieval/ollama-lifecycle.ts
import { exec } from '@/lib/shared/shell';

async function ollamaReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(url: string, maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await ollamaReachable(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureModelPulled(ollamaUrl: string, model: string): Promise<void> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    const pulled = data.models.some((m) => m.name.startsWith(model));
    if (!pulled) {
      console.log(`[retrieval] Pulling ${model}...`);
      await exec('ollama', ['pull', model], { timeout: 300_000 });
    }
  } catch (err) {
    console.warn('[retrieval] ensureModelPulled failed:', err);
  }
}

export async function ensureOllamaRunning(opts: {
  ollamaUrl: string;
  embeddingModel: string;
  manageOllama: boolean;
}): Promise<void> {
  if (!opts.manageOllama) return;

  if (await ollamaReachable(opts.ollamaUrl)) {
    await ensureModelPulled(opts.ollamaUrl, opts.embeddingModel);
    return;
  }

  console.log('[retrieval] Ollama not running — starting via PM2');
  const pm2Describe = await exec('pm2', ['describe', 'ollama-serve'], { timeout: 5000 });

  if (pm2Describe.exitCode !== 0) {
    await exec('pm2', ['start', 'ollama', '--name', 'ollama-serve', '--', 'serve'], { timeout: 10_000 });
  } else {
    await exec('pm2', ['restart', 'ollama-serve'], { timeout: 10_000 });
  }

  const up = await waitForOllama(opts.ollamaUrl);
  if (!up) {
    console.warn('[retrieval] Ollama did not start within 5s — retrieval unavailable this session');
    return;
  }

  await ensureModelPulled(opts.ollamaUrl, opts.embeddingModel);
}
```

- [ ] **Step 2: Add boot call to instrumentation-node.ts**

Find `void runProbeSweep();` (around line 455). Immediately after it, add:

```typescript
  // Start Ollama via PM2 when retrieval is enabled
  try {
    const { getSettings: _getCfg } = await import('@/lib/shared/config');
    const _cfg = _getCfg();
    if (_cfg.retrieval_enabled) {
      const { ensureOllamaRunning } = await import('@/lib/agents/retrieval/ollama-lifecycle');
      void ensureOllamaRunning({
        ollamaUrl: _cfg.retrieval_ollama_url,
        embeddingModel: _cfg.retrieval_embedding_model,
        manageOllama: _cfg.retrieval_manage_ollama,
      }).catch((err) => console.warn('[retrieval] Ollama lifecycle error:', err));
    }
  } catch (err) {
    console.warn('[retrieval] boot check failed:', err);
  }
```

- [ ] **Step 3: Type-check**

```bash
pnpm type-check
```

Expected: no errors.

---

## Task 14: Update docs/SETTINGS.md

**Files:**
- Modify: `docs/SETTINGS.md`

- [ ] **Step 1: Add retrieval section**

Find an appropriate location (after CLI settings) and add:

```markdown
### Retrieval

| Key | Type | Default | Description |
|---|---|---|---|
| `retrieval_enabled` | bool | `false` | Master gate — nothing runs if off |
| `retrieval_ollama_url` | string | `http://localhost:11434` | Ollama base URL |
| `retrieval_embedding_model` | string | `nomic-embed-text` | Ollama embedding model name |
| `retrieval_context_limit` | int | `5` | Max snippets injected per agent prompt |
| `retrieval_score_threshold` | float | `0.8` | Min similarity score to include a result |
| `retrieval_manage_ollama` | bool | `true` | Whether TamTam starts Ollama via PM2 if not running |
```

---

## Task 15: Final verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 2: Type-check**

```bash
pnpm type-check
```

Expected: no errors.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 4: Enable retrieval in the DB and rebuild**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/db/tamtam.db');
db.prepare(\"INSERT OR REPLACE INTO settings (key, value) VALUES ('retrieval_enabled', 'true')\").run();
console.log('retrieval_enabled set');
"
pnpm run rebuild
```

- [ ] **Step 5: Check PM2 and retrieval logs**

```bash
pm2 list | grep ollama
pnpm logs 2>&1 | grep retrieval | head -20
```

Expected: `ollama-serve` visible in `pm2 list`; `[retrieval]` log lines showing Ollama lifecycle and model status.

- [ ] **Step 6: Smoke test reindex**

```bash
curl -s -X POST http://localhost:1337/api/projects/tamtam/retrieval/reindex | jq
```

Expected: `{ "chunks": N }` where N > 0.

- [ ] **Step 7: Verify retrieval_records populated after agent run**

Run any agent from the TamTam UI, then:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/db/tamtam.db');
console.log(db.prepare('SELECT * FROM retrieval_records LIMIT 5').all());
console.log(db.prepare('SELECT COUNT(*) as n FROM retrieval_chunks').get());
"
```

Expected: rows in `retrieval_records` with `source_kind = 'agent_run'`; chunk count > 0.

---

## Implementation Notes

**Exporting `sqlite` from lib/db/index.ts:** The raw `better-sqlite3` Database instance (`sqlite`) needs to be exported so `SqliteVecBackend` can receive it. Add `export { sqlite };` at the bottom of `lib/db/index.ts` before the `export const db = drizzle(...)` line.

**glob dependency:** Check if `glob` is already in `package.json`. If not: `pnpm add glob` + `pnpm audit`.

**Score calibration:** The formula `1 - d²/2` approximates cosine similarity from Euclidean distance for unnormalized vectors. The threshold of 0.8 may return zero results early on when the index is sparse — lower it to 0.5 if needed during initial testing and tune upward once the index has content.

**Self-review checklist:**
- Spec §Architecture → Tasks 1–3 ✓
- Spec §RetrievalBackend → Task 3 ✓
- Spec §DB Schema → Task 2 ✓
- Spec §Ingestion (agent_run) → Task 8 + 10 ✓
- Spec §Ingestion (project_doc) → Task 12 ✓
- Spec §Prompt-time Retrieval → Task 9 + 11 ✓
- Spec §Ollama Lifecycle → Task 13 ✓
- Spec §Settings → Task 7 + 14 ✓
- Spec §Testing → Tasks 4–9, 12 ✓
- Spec §Migration path → documented in backend.ts interface (no Task needed) ✓
- Spec §Security → project isolation enforced in SqliteVecBackend.search() ✓
