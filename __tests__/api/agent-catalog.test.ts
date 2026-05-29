import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/agent-catalog/route';

describe('GET /api/agent-catalog', () => {
  it('returns the entries array with the public catalog shape', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries.length).toBeGreaterThan(0);
    for (const entry of data.entries) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(['cli', 'internal']).toContain(entry.dispatch);
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(Array.isArray(entry.skillIds)).toBe(true);
      expect(typeof entry.autoSeed).toBe('boolean');
      expect(['essential', 'featured', 'recommended', null]).toContain(entry.tier);
      expect(typeof entry.fallbackEnabled).toBe('boolean');
    }
  });

  it('exposes catalog tiers through the public API', async () => {
    const res = await GET();
    const data = await res.json();
    const improve = data.entries.find((entry: { name: string }) => entry.name === 'improve');
    expect(improve?.tier).toBe('featured');
  });

  it('exposes file-backed prerequisite templates in the public catalog', async () => {
    const res = await GET();
    const data = await res.json();
    const qa = data.entries.find((entry: { name: string }) => entry.name === 'qa');
    const improve = data.entries.find((entry: { name: string }) => entry.name === 'improve');

    expect(qa?.prerequisiteCommand).toContain('{{project}}/config');
    expect(improve?.prerequisiteCommand).toContain('## Top 5 oldest candidate files');
  });

  it('does not leak the server-only handlerKey field', async () => {
    const res = await GET();
    const data = await res.json();
    for (const entry of data.entries) {
      expect(entry).not.toHaveProperty('handlerKey');
      expect(entry).not.toHaveProperty('handler');
    }
  });
});
