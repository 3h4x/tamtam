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
      'nomic-embed-text',
      expect.objectContaining({
        project: 'myproject',
        sourceKind: 'agent_run',
      })
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

  it('returns stored false when vector upsert fails', async () => {
    mockBackend.upsertChunks.mockImplementationOnce(() => {
      throw new Error('vec table missing');
    });

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
    })).resolves.toEqual(expect.objectContaining({
      skipped: false,
      stored: false,
    }));
  });
});
