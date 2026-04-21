import { describe, it, expect, vi, afterEach } from 'vitest';

// Isolate only the updateAgent skillIds normalisation — avoid importing the full
// client-api module (which references browser globals) by extracting the logic
// under test into a local helper that mirrors the implementation exactly.
function normaliseSkillIds(raw: unknown): string[] {
  if (typeof raw === 'string') return JSON.parse(raw) as string[];
  return (raw as string[] | null | undefined) ?? [];
}

describe('updateAgent – skillIds normalisation', () => {
  it('parses a JSON string into an array', () => {
    expect(normaliseSkillIds('["skill-a","skill-b"]')).toEqual(['skill-a', 'skill-b']);
  });

  it('returns an array as-is when the server already returns one', () => {
    expect(normaliseSkillIds(['skill-a', 'skill-b'])).toEqual(['skill-a', 'skill-b']);
  });

  it('returns an empty array when skillIds is null', () => {
    expect(normaliseSkillIds(null)).toEqual([]);
  });

  it('returns an empty array when skillIds is undefined', () => {
    expect(normaliseSkillIds(undefined)).toEqual([]);
  });

  it('parses an empty JSON array string', () => {
    expect(normaliseSkillIds('[]')).toEqual([]);
  });
});

// Integration: test the full updateAgent fetch path with a mocked fetch.
describe('updateAgent – fetch integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callUpdateAgent(responseBody: object) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => responseBody,
      })
    );
    // Dynamic import so the module picks up the stubbed fetch at call time.
    const { updateAgent } = await import('@/lib/client-api');
    return updateAgent('agent-1', { name: 'My Agent' });
  }

  it('returns skillIds as array when server returns JSON string', async () => {
    const result = await callUpdateAgent({
      agent: { id: 'agent-1', name: 'My Agent', skillIds: '["s1","s2"]' },
    });
    expect(result.agent.skillIds).toEqual(['s1', 's2']);
  });

  it('returns skillIds as array when server already returns array', async () => {
    const result = await callUpdateAgent({
      agent: { id: 'agent-1', name: 'My Agent', skillIds: ['s1', 's2'] },
    });
    expect(result.agent.skillIds).toEqual(['s1', 's2']);
  });

  it('returns empty array when server returns null skillIds', async () => {
    const result = await callUpdateAgent({
      agent: { id: 'agent-1', name: 'My Agent', skillIds: null },
    });
    expect(result.agent.skillIds).toEqual([]);
  });

  it('throws when response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ detail: 'not found' }),
      })
    );
    const { updateAgent } = await import('@/lib/client-api');
    await expect(updateAgent('bad-id', {})).rejects.toThrow('not found');
  });
});
