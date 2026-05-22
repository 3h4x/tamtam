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
      expect(typeof entry.fallbackEnabled).toBe('boolean');
    }
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
