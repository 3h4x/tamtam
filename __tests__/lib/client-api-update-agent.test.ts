import { describe, it, expect, vi, afterEach } from 'vitest';

// skillIds normalisation now happens server-side in lib/agents-cache.ts (normalizeAgent).
// The updateAgent client function passes the server response through unchanged.
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

  it('returns the server response as-is', async () => {
    const result = await callUpdateAgent({
      agent: { id: 'agent-1', name: 'My Agent', skillIds: ['s1', 's2'] },
    });
    expect(result.agent.skillIds).toEqual(['s1', 's2']);
  });

  it('returns empty array when server returns empty skillIds', async () => {
    const result = await callUpdateAgent({
      agent: { id: 'agent-1', name: 'My Agent', skillIds: [] },
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
