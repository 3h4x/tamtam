import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.hoisted(() => vi.fn());
const mockListProjectDocuments = vi.hoisted(() => vi.fn().mockReturnValue(['/tmp/workspace/myproject/README.md']));
const mockIsSqliteVecAvailable = vi.hoisted(() => vi.fn().mockReturnValue(true));

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
  SqliteVecBackend: vi.fn().mockImplementation(function(this: {
    upsertChunks: typeof mockUpsert;
    search: ReturnType<typeof vi.fn>;
    deleteSource: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
  }) {
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

vi.mock('@/lib/shared/project-documents', () => ({
  listProjectDocuments: mockListProjectDocuments,
}));
vi.mock('@/lib/db/sqlite-vec', () => ({
  isSqliteVecAvailable: mockIsSqliteVecAvailable,
  getSqliteVecUnavailableDetail: vi.fn().mockReturnValue(
    'Retrieval is unavailable: sqlite-vec is not installed in this environment'
  ),
}));
vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('# README\n\nProject docs here.'),
}));

describe('POST /api/projects/[schedId]/retrieval/reindex', () => {
  beforeEach(() => {
    mockUpsert.mockClear();
    mockListProjectDocuments.mockClear();
    mockIsSqliteVecAvailable.mockReturnValue(true);
  });

  it('returns 400 when retrieval is disabled', async () => {
    vi.resetModules();
    const { getSettings } = await import('@/lib/shared/config');
    vi.mocked(getSettings).mockReturnValueOnce({ retrieval_enabled: false } as ReturnType<typeof getSettings>);
    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });
    expect(res.status).toBe(400);
  });

  it('returns 200 with chunk count on success', async () => {
    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { chunks: number };
    expect(typeof body.chunks).toBe('number');
  });

  it('returns 503 when sqlite-vec is unavailable', async () => {
    mockIsSqliteVecAvailable.mockReturnValue(false);
    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });
    expect(res.status).toBe(503);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('sqlite_vec_unavailable');
    expect(mockListProjectDocuments).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
