import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agents/retrieval/ollama-usage', () => ({ recordOllamaUsage: mockRecord }));

import { embedText } from '@/lib/agents/retrieval/ollama-embedder';

beforeEach(() => { mockFetch.mockReset(); mockRecord.mockReset(); });

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

  it('records usage with Ollama-reported tokens and duration when available', async () => {
    const vec = Array(768).fill(0);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [vec], prompt_eval_count: 42, total_duration: 7_500_000 }),
    });

    await embedText('hi', 'http://localhost:11434', 'nomic-embed-text', { project: 'foo', sourceKind: 'project_doc' });

    expect(mockRecord).toHaveBeenCalledWith({
      model: 'nomic-embed-text',
      project: 'foo',
      sourceKind: 'project_doc',
      inputTokens: 42,
      durationMs: 7.5,
    });
  });

  it('falls back to estimated tokens and wall-clock when Ollama omits metrics', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [Array(768).fill(0)] }) });

    await embedText('abcdefgh', 'http://localhost:11434', 'nomic-embed-text');

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const arg = mockRecord.mock.calls[0][0];
    expect(arg.inputTokens).toBe(2);
    expect(arg.project).toBeNull();
    expect(arg.sourceKind).toBeNull();
  });

  it('does not record usage when Ollama returns non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(embedText('x', 'http://localhost:11434', 'nomic-embed-text'))
      .rejects.toThrow();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
