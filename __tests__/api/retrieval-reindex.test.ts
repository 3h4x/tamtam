import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.hoisted(() => vi.fn());
const mockDeleteSource = vi.hoisted(() => vi.fn());
const mockExistingRecords = vi.hoisted<
  Array<{
    id: string;
    project: string;
    sourceKind: string;
    sourceId: string;
    chunkCount: number;
    contentHash: string;
    indexedAt: number;
  }>
>(() => []);
const mockInsertRun = vi.hoisted(() => vi.fn());
const mockIsSqliteVecAvailable = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockCollectProjectRetrievalSources = vi.hoisted(() => vi.fn().mockReturnValue([
  {
    recordId: 'myproject:project_doc:README.md',
    sourceKind: 'project_doc',
    sourceId: 'README.md',
    text: '# README\n\nProject docs here.',
    metadata: { filePath: 'README.md' },
    updatedAt: 100,
  },
  {
    recordId: 'myproject:skill:skill-1',
    sourceKind: 'skill',
    sourceId: 'skill-1',
    text: '# Skill\n\nUse focused tests first.',
    metadata: { skillTitle: 'Skill 1' },
    updatedAt: 200,
  },
]));

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
    countProjectChunks: ReturnType<typeof vi.fn>;
    deleteSource: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
  }) {
    this.upsertChunks = mockUpsert;
    this.search = vi.fn();
    this.countProjectChunks = vi.fn().mockReturnValue(0);
    this.deleteSource = mockDeleteSource;
    this.deleteProject = vi.fn();
  }),
}));

vi.mock('@/lib/db', () => ({
  sqlite: {},
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn(() => mockExistingRecords),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({ run: mockInsertRun }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  },
  schema: { retrievalRecords: { id: 'id', project: 'project', sourceKind: 'source_kind' } },
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: vi.fn().mockReturnValue('/tmp/workspace/myproject'),
}));

vi.mock('@/lib/agents/retrieval/project-corpus', () => ({
  collectProjectRetrievalSources: mockCollectProjectRetrievalSources,
}));
vi.mock('@/lib/db/sqlite-vec', () => ({
  isSqliteVecAvailable: mockIsSqliteVecAvailable,
  getSqliteVecUnavailableDetail: vi.fn().mockReturnValue(
    'Retrieval is unavailable: sqlite-vec is not installed in this environment'
  ),
}));
describe('POST /api/projects/[schedId]/retrieval/reindex', () => {
  beforeEach(() => {
    mockUpsert.mockClear();
    mockDeleteSource.mockClear();
    mockExistingRecords.length = 0;
    mockInsertRun.mockClear();
    mockCollectProjectRetrievalSources.mockClear();
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
    const body = await res.json() as { chunks: number; indexedSources: number; diagnostics: { sourceCounts: Record<string, number> } };
    expect(typeof body.chunks).toBe('number');
    expect(body.indexedSources).toBe(2);
    expect(body.diagnostics.sourceCounts.project_doc).toBe(1);
    expect(body.diagnostics.sourceCounts.skill).toBe(1);
  });

  it('returns 503 when sqlite-vec is unavailable', async () => {
    mockIsSqliteVecAvailable.mockReturnValue(false);
    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });
    expect(res.status).toBe(503);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('sqlite_vec_unavailable');
    expect(mockCollectProjectRetrievalSources).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('refreshes indexedAt for timestamp-only stale sources without re-embedding', async () => {
    const text = '# README\n\nProject docs here.';
    const contentHash = createHash('sha256').update(text).digest('hex');
    mockCollectProjectRetrievalSources.mockReturnValueOnce([
      {
        recordId: 'myproject:project_doc:README.md',
        sourceKind: 'project_doc',
        sourceId: 'README.md',
        text,
        metadata: { filePath: 'README.md' },
        updatedAt: 200,
      },
    ]);
    mockExistingRecords.push({
      id: 'myproject:project_doc:README.md',
      project: 'myproject',
      sourceKind: 'project_doc',
      sourceId: 'README.md',
      chunkCount: 3,
      contentHash,
      indexedAt: 100,
    });

    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      skippedSources: number;
      diagnostics: { staleSourcesBeforeReindex: number };
    };
    expect(body.skippedSources).toBe(1);
    expect(body.diagnostics.staleSourcesBeforeReindex).toBe(1);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDeleteSource).not.toHaveBeenCalled();
    expect(mockInsertRun).toHaveBeenCalledOnce();
  });

  it('purges stale file-agent project-doc rows that are no longer in the trusted corpus', async () => {
    mockCollectProjectRetrievalSources.mockReturnValueOnce([
      {
        recordId: 'myproject:project_doc:README.md',
        sourceKind: 'project_doc',
        sourceId: 'README.md',
        text: '# README\n\nProject docs here.',
        metadata: { filePath: 'README.md' },
        updatedAt: 100,
      },
    ]);
    mockExistingRecords.push({
      id: 'myproject:project_doc:.tamtam/agents/qa.md',
      project: 'myproject',
      sourceKind: 'project_doc',
      sourceId: '.tamtam/agents/qa.md',
      chunkCount: 2,
      contentHash: 'stale',
      indexedAt: 100,
    });

    const { POST } = await import('@/app/api/projects/[schedId]/retrieval/reindex/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ schedId: 'myproject' }) });

    expect(res.status).toBe(200);
    expect(mockDeleteSource).toHaveBeenCalledWith('myproject', 'project_doc', '.tamtam/agents/qa.md');
    const body = await res.json() as { diagnostics: { staleSourcesBeforeReindex: number } };
    expect(body.diagnostics.staleSourcesBeforeReindex).toBe(1);
  });
});
