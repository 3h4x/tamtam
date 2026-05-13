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
    expect(chunks.every((chunk) => chunk.length <= CHUNK_SIZE)).toBe(true);
  });

  it('keeps markdown headings attached to the following section when possible', () => {
    const text = ['# Alpha', 'first section', '', '# Beta', 'second section'].join('\n');
    const chunks = chunkText(text);
    expect(chunks).toEqual(['# Alpha\nfirst section\n\n# Beta\nsecond section']);
  });

  it('splits oversized sections while preserving their heading', () => {
    const text = `# Big Section\n\n${'x'.repeat(CHUNK_SIZE + 300)}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith('# Big Section'))).toBe(true);
  });

  it('prefers paragraph boundaries for medium-sized markdown sections', () => {
    const paragraph = 'word '.repeat(120);
    const text = ['# One', paragraph, '', '# Two', paragraph, '', '# Three', paragraph].join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.includes('#'))).toBe(true);
  });
});
