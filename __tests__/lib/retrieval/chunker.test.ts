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
