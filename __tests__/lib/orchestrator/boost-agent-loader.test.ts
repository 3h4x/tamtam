import { describe, expect, it, vi } from 'vitest';
import { loadBoostAgents } from '@/lib/orchestrator/boost-agent-loader';

describe('loadBoostAgents', () => {
  it('continues without fruitfulness stats when optional enrichment fails', async () => {
    const warn = vi.fn();
    const agents = await loadBoostAgents({
      listAgents: vi.fn(async () => [
        {
          id: 'agent-1',
          project: 'app',
          name: 'improve',
          schedule: '15m',
          prompt: '',
          enabled: true,
          kind: 'user' as const,
          boostable: true,
        },
      ]),
      getDispatches: vi.fn(() => new Map([['agent-1', 123]])),
      loadFruitfulness: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
      onFruitfulnessError: warn,
    });

    expect(agents).toEqual([
      {
        id: 'agent-1',
        project: 'app',
        name: 'improve',
        enabled: true,
        schedule: '15m',
        lastDispatchMs: 123,
        kind: 'user',
        boostable: true,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.any(Error));
  });

  it('attaches fruitfulness stats when enrichment succeeds', async () => {
    const agents = await loadBoostAgents({
      listAgents: vi.fn(async () => [
        {
          id: 'agent-1',
          project: 'app',
          name: 'improve',
          schedule: '15m',
          prompt: '',
          enabled: true,
          kind: 'user' as const,
          boostable: true,
        },
      ]),
      getDispatches: vi.fn(() => new Map<string, number>()),
      loadFruitfulness: vi.fn(async () => new Map([
        ['agent-1', {
          runs: 5,
          fruitfulRuns: 0,
          rate: 0,
          totalLinesChanged: 0,
          totalFilesChanged: 0,
          lastRunAt: 100,
        }],
      ])),
    });

    expect(agents[0].fruitfulness).toEqual({ rate: 0, runs: 5 });
  });
});
