import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.hoisted(() => vi.fn());

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

vi.mock('@/lib/agents/retrieval/sqlite-vec-backend', () => ({
  SqliteVecBackend: vi.fn().mockImplementation(function() {
    this.upsertChunks = mockUpsert;
    this.search = vi.fn();
    this.deleteSource = vi.fn();
    this.deleteProject = vi.fn();
  }),
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
  beforeEach(() => { mockUpsert.mockClear(); });

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
