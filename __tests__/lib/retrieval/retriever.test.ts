import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievalResult } from '@/lib/agents/retrieval/backend';

const mockEmbed = vi.hoisted(() => vi.fn().mockResolvedValue(Array(768).fill(0.1)));
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
