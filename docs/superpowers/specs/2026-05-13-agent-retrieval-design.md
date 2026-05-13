# Agent Retrieval Design

**Date:** 2026-05-13
**Status:** Approved
**Issues:** #96, #97, #100, #103

## Overview

Add a semantic retrieval layer to TamTam so agents can search past run reports, project docs, and skills at prompt time. Vector storage uses `sqlite-vec` (SQLite extension) inside the existing `tamtam.db`. Embeddings are generated locally by Ollama running `nomic-embed-text`. Ollama is managed by PM2 alongside TamTam.

The retrieval backend is behind a typed interface (`RetrievalBackend`) so the implementation can migrate to pgvector/Supabase by swapping one file.

---

## Why This Stack

| Candidate | Decision | Reason |
|---|---|---|
| **sqlite-vec** | ✓ Chosen | No new processes, lives in `tamtam.db`, testable with in-memory SQLite, fits existing Drizzle + better-sqlite3 patterns |
| **LanceDB** | ✗ | Second storage system outside SQLite, no advantage over sqlite-vec for TamTam's scale |
| **Mem0 OSS** | ✗ | Python sidecar + vector store; extraction is redundant given `agent-run-report.ts` already produces structured summaries |
| **Graphiti** | Future option | Right for temporal/relational queries (repeated findings across releases, verdict lineage); too heavy now (Python + Neo4j). Design for it by keeping the interface backend-neutral |
| **Pinecone cloud** | ✗ | Violates local-first requirement |

**Embeddings:** `nomic-embed-text` via Ollama. 768-dim float32 vectors. Validated: similar pair cosine ~0.91, dissimilar ~0.33. Cosine similarity threshold ≥ 0.8 filters noise.

**Migration path to pgvector/Supabase:** identical operations (upsert, KNN search, delete by project), different SQL. Swap `sqlite-vec-backend.ts` for `pgvector-backend.ts`, re-upsert existing records via one-off script.

---

## Architecture

```
lib/agents/retrieval/
  backend.ts              — RetrievalBackend interface (migration seam)
  sqlite-vec-backend.ts   — sqlite-vec implementation
  ollama-embedder.ts      — HTTP client for Ollama /api/embed
  chunker.ts              — splits long docs into fixed-size chunks with overlap
  ingestion.ts            — orchestrates embed → upsert for all source kinds
  retriever.ts            — prompt-time search → ## Retrieved Context block
```

Two additions to `tamtam.db`:
- `retrieval_records` table (Drizzle-managed) — tracks what is indexed, enables dedup and change detection
- `vec_chunks` virtual table (sqlite-vec) — stores 768-dim float32 vectors with metadata

---

## RetrievalBackend Interface

```typescript
// lib/agents/retrieval/backend.ts

export type SourceKind = 'agent_run' | 'project_doc' | 'skill';

export interface RetrievalChunk {
  id: string;            // `${sourceKind}:${sourceId}:${chunkIndex}` — deterministic
  text: string;
  embedding: number[];   // 768-dim float32
  project: string;
  sourceKind: SourceKind;
  sourceId: string;      // jobId | file path | skillId
  metadata: Record<string, string>;
}

export interface RetrievalResult {
  text: string;
  sourceKind: SourceKind;
  sourceId: string;
  score: number;         // cosine similarity, higher = more similar
  metadata: Record<string, string>;
}

export interface RetrievalBackend {
  upsert(chunks: RetrievalChunk[]): Promise<void>;
  search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): Promise<RetrievalResult[]>;
  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): Promise<void>;
  deleteProject(project: string): Promise<void>;
}
```

`project` is a required filter on every `search` call — cross-project memory bleed is architecturally impossible. Chunk IDs are deterministic so re-indexing the same source is idempotent.

---

## DB Schema

### `retrieval_records` table (Drizzle)

```
id            TEXT PRIMARY KEY
project       TEXT NOT NULL
sourceKind    TEXT NOT NULL   -- 'agent_run' | 'project_doc' | 'skill'
sourceId      TEXT NOT NULL   -- jobId, file path, or skillId
chunkCount    INTEGER NOT NULL
contentHash   TEXT NOT NULL   -- SHA-256 of input text, used to skip unchanged content
indexedAt     INTEGER NOT NULL
```

Unique index on `(project, sourceKind, sourceId)`.

### `vec_chunks` virtual table (sqlite-vec)

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  id TEXT PRIMARY KEY,
  project TEXT,
  source_kind TEXT,
  source_id TEXT,
  embedding FLOAT[768]
);
```

Text content and metadata are stored in a companion `retrieval_chunks` table joined by `id`, keeping the vector table lean.

### `retrieval_chunks` table (Drizzle)

```
id          TEXT PRIMARY KEY    -- matches vec_chunks.id
project     TEXT NOT NULL
sourceKind  TEXT NOT NULL
sourceId    TEXT NOT NULL
chunkIndex  INTEGER NOT NULL
text        TEXT NOT NULL       -- raw chunk text shown in ## Retrieved Context
metadata    TEXT NOT NULL       -- JSON stringified Record<string, string>
```

---

## Ingestion

All ingestion is best-effort — failures log a warning and never block job completion or skill saves.

### `agent_run`
- **Trigger:** `finalizeAgentRunReport` in `lib/agents/agent-run-report.ts` after job completes
- **Text:** `workSummary` + comma-separated `modifiedFiles` + agent name + exit code
- **Chunking:** single chunk (summaries are already compact)
- **Metadata:** `agentId`, `agentName`, `jobId`, `exitCode`, `completedAt`
- **Dedup:** skip if `retrieval_records` row exists with same `contentHash`

### `project_doc`
- **Trigger:** `POST /api/projects/[name]/retrieval/reindex` (on-demand; also called when project page opens if no index exists)
- **Sources:** `CLAUDE.md`, `README.md`, `docs/**/*.md`, `.tamtam/agents/*.md`
- **Chunking:** 1800 characters with 200-character overlap (≈ 512 tokens at ~3.5 chars/token; character-based to avoid a tokenizer dependency)
- **Metadata:** `filePath`, `lastModified`
- **Dedup:** re-index if `lastModified` differs from stored value

### `skill`
- **Trigger:** skill create/update routes in `app/api/skills/`
- **Text:** skill title + body
- **Chunking:** single chunk for short skills, split at 1800 characters for long ones
- **Metadata:** `skillId`, `skillTitle`, `category`
- **Dedup:** re-index on every save (skills are small)

---

## Prompt-time Retrieval

Single call site in `app/api/agents/[agentId]/run/route.ts`, after task prompt is known, before `withBasePrompt`:

```typescript
// lib/agents/retrieval/retriever.ts
retrieveAgentContext(opts: {
  project: string;
  agentId: string;
  taskPrompt: string;
  limit: number;
}): Promise<string | null>
```

Steps:
1. Embed `taskPrompt` via Ollama
2. `backend.search({ embedding, project, limit })`
3. Drop results with cosine similarity < 0.8
4. Format into `## Retrieved Context` block (see below)
5. Return `null` if retrieval is disabled, Ollama is unreachable, or no results survive threshold

**Injected block format:**
```
## Retrieved Context
The following was retrieved from past runs and project knowledge.
Use it to avoid repeating work and stay consistent with prior decisions.

[agent_run · review-agent · 2026-05-01]
No security issues found in lib/pipeline/. Auth middleware verified correct.

[project_doc · docs/PIPELINE.md]
The fix loop cap is 3 iterations per release...

[skill · senior-fullstack]
Always run pnpm type-check before committing...
```

Block is prepended to `corePrompt` before `withBasePrompt`. No block is added when retrieval is disabled or returns nothing — zero change to existing prompt for users who have not configured retrieval.

---

## Ollama Lifecycle (PM2)

Ollama is managed by PM2 as a named process (`ollama-serve`), consistent with how TamTam manages other services.

**Boot sequence** (in `instrumentation-node.ts` when `retrieval_enabled` is true):

1. `GET {ollama_url}/api/tags` — if reachable, done
2. Check `pm2 describe ollama-serve`:
   - No entry → `pm2 start ollama --name ollama-serve -- serve`
   - Stopped → `pm2 restart ollama-serve`
3. Poll endpoint for up to 5s
4. If up: check `nomic-embed-text` is in model list; if missing, run `ollama pull nomic-embed-text`
5. If still not reachable after 5s: log warning, retrieval disabled for session

`retrieval_manage_ollama` setting (default `true`) lets users opt out if they manage Ollama themselves (Ollama.app, brew services, remote host).

`pnpm stop` stops TamTam's PM2 entry only — `ollama-serve` keeps running since other tools may use it.

---

## Settings

All new keys follow existing `docs/SETTINGS.md` conventions:

| Key | Type | Default | Description |
|---|---|---|---|
| `retrieval_enabled` | bool | `false` | Master gate — nothing runs if off |
| `retrieval_ollama_url` | string | `http://localhost:11434` | Ollama base URL |
| `retrieval_embedding_model` | string | `nomic-embed-text` | Any Ollama-compatible embedding model |
| `retrieval_context_limit` | int | `5` | Max snippets injected per agent prompt |
| `retrieval_score_threshold` | float | `0.8` | Min cosine similarity to include a result |
| `retrieval_manage_ollama` | bool | `true` | Whether TamTam starts/manages Ollama via PM2 |
| `retrieval_backend` | string | `sqlite-vec` | Backend selector (`sqlite-vec` now; `pgvector` future) |

Exposed in **Settings → CLI**, new "Retrieval" section. Health check on that page pings Ollama and reports model status.

---

## Testing

### Unit tests (`__tests__/lib/retrieval/`)

- `ollama-embedder.test.ts` — mock HTTP, verify request shape, error on Ollama down
- `chunker.test.ts` — chunk sizes, overlap, edge cases (empty doc, doc shorter than chunk size)
- `ingestion.test.ts` — mock embedder + backend; verify dedup via `retrieval_records`, idempotent upsert, best-effort failure (backend throws → job still completes)
- `retriever.test.ts` — mock backend returns, verify `## Retrieved Context` block format, score threshold filtering, `null` when disabled

### API tests (`__tests__/api/`)

- `retrieval-reindex.test.ts` — in-memory SQLite + mocked Ollama; POST triggers doc scan and upsert, returns 200 with chunk count

### Backend integration test (`__tests__/lib/retrieval/`)

- `sqlite-vec-backend.test.ts` — loads real sqlite-vec extension against in-memory SQLite; round-trip upsert → search; `deleteProject` removes all rows; project isolation (search for project A never returns project B results)

### What is skipped

No e2e test for the full retrieval flow — unit + API layer covers behaviour without requiring a real Ollama instance in CI.

### CI note

sqlite-vec ships pre-built binaries per platform. Backend constructor selects the correct binary for the runner OS, same pattern as better-sqlite3.

---

## Migration Path to pgvector / Supabase

1. Implement `pgvector-backend.ts` satisfying the same `RetrievalBackend` interface (~100 lines)
2. Set `retrieval_backend: 'pgvector'` in settings
3. Run a one-off re-index script to re-embed and upsert all existing `retrieval_records`
4. Supabase: enable pgvector extension, create `match_documents` RPC function per Supabase vector docs

No callers change — the interface is the only boundary.

---

## Security

- `project` is always a required filter — retrieval results are scoped to the calling project
- Chunk text is sourced only from: agent run summaries (already sanitized by `extractWorkSummary`), committed project docs, and DB-backed skills — no raw log content, no secret values
- `chunker.ts` has a max-chunk-size guard so malformed docs cannot produce unbounded embeddings
- File paths in `project_doc` are resolved relative to the project root and checked against path traversal (same pattern as `agent-memory.ts` `sanitizeName`)
