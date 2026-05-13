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
