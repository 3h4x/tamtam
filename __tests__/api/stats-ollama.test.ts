import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE ollama_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      model TEXT NOT NULL,
      project TEXT,
      source_kind TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const testDb = createTestDb();

vi.mock('@/lib/db', () => ({ db: testDb.db, schema, sqlite: testDb.sqlite }));

const seed = (rows: { ts: number; model: string; project?: string | null; sourceKind?: string | null; inputTokens: number; durationMs: number }[]) => {
  for (const r of rows) {
    testDb.db.insert(schema.ollamaUsage).values({
      ts: r.ts,
      model: r.model,
      project: r.project ?? null,
      sourceKind: r.sourceKind ?? null,
      inputTokens: r.inputTokens,
      durationMs: r.durationMs,
    }).run();
  }
};

beforeEach(() => {
  testDb.sqlite.exec('DELETE FROM ollama_usage');
  vi.resetModules();
  vi.doMock('@/lib/db', () => ({ db: testDb.db, schema, sqlite: testDb.sqlite }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/stats/ollama', () => {
  it('returns zero totals for an empty table', async () => {
    const { GET } = await import('@/app/api/stats/ollama/route');
    const url = new URL('http://localhost/api/stats/ollama?window=24h');
    const res = await GET({ nextUrl: url } as never);
    const body = await res.json();

    expect(body.window).toBe('24h');
    expect(body.totals).toEqual({ calls: 0, inputTokens: 0, durationMs: 0, lastCallAt: null });
    expect(body.models).toEqual([]);
    expect(body.sources).toEqual([]);
    expect(body.projects).toEqual([]);
  });

  it('aggregates totals and groups by model, source, and project', async () => {
    const now = Date.now() / 1000;
    seed([
      { ts: now - 60, model: 'nomic-embed-text', project: 'a', sourceKind: 'project_doc', inputTokens: 100, durationMs: 50 },
      { ts: now - 120, model: 'nomic-embed-text', project: 'a', sourceKind: 'query', inputTokens: 10, durationMs: 5 },
      { ts: now - 180, model: 'nomic-embed-text', project: 'b', sourceKind: 'project_doc', inputTokens: 200, durationMs: 100 },
      { ts: now - 240, model: 'bge-large', project: null, sourceKind: null, inputTokens: 50, durationMs: 25 },
    ]);

    const { GET } = await import('@/app/api/stats/ollama/route');
    const url = new URL('http://localhost/api/stats/ollama?window=24h');
    const res = await GET({ nextUrl: url } as never);
    const body = await res.json();

    expect(body.totals.calls).toBe(4);
    expect(body.totals.inputTokens).toBe(360);
    expect(body.totals.durationMs).toBe(180);
    expect(body.totals.lastCallAt).toBeGreaterThan(now - 61);

    expect(body.models.find((m: { model: string }) => m.model === 'nomic-embed-text')).toMatchObject({ calls: 3, inputTokens: 310 });
    expect(body.models.find((m: { model: string }) => m.model === 'bge-large')).toMatchObject({ calls: 1, inputTokens: 50 });

    expect(body.projects.find((p: { project: string }) => p.project === 'a')).toMatchObject({ calls: 2, inputTokens: 110 });
    expect(body.projects.find((p: { project: string }) => p.project === '(none)')).toMatchObject({ calls: 1 });

    expect(body.sources.find((s: { sourceKind: string }) => s.sourceKind === 'query')).toMatchObject({ calls: 1, inputTokens: 10 });
  });

  it('filters out rows outside the requested window', async () => {
    const now = Date.now() / 1000;
    seed([
      { ts: now - 60, model: 'm', inputTokens: 1, durationMs: 1 },
      { ts: now - 48 * 60 * 60, model: 'm', inputTokens: 999, durationMs: 999 },
    ]);

    const { GET } = await import('@/app/api/stats/ollama/route');
    const url = new URL('http://localhost/api/stats/ollama?window=24h');
    const res = await GET({ nextUrl: url } as never);
    const body = await res.json();

    expect(body.totals.calls).toBe(1);
    expect(body.totals.inputTokens).toBe(1);
  });

  it('defaults to 30d when window param is missing or invalid', async () => {
    const { GET } = await import('@/app/api/stats/ollama/route');
    const res = await GET({ nextUrl: new URL('http://localhost/api/stats/ollama?window=bogus') } as never);
    const body = await res.json();
    expect(body.window).toBe('30d');
  });
});
