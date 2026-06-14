import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

let handle: TestDbHandle;

beforeEach(async () => {
  vi.resetModules();
  handle = await createTestPgDb();
  vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
});

afterEach(async () => {
  vi.doUnmock('@/lib/db');
  await handle?.[Symbol.asyncDispose]();
});

function meta(agentId: string, agentName: string, triggeredBy: 'manual' | 'schedule') {
  return JSON.stringify({ agent: { id: agentId, name: agentName, triggeredBy } });
}

async function insertJob(overrides: Partial<typeof schema.jobs.$inferInsert> = {}) {
  await handle.db.insert(schema.jobs).values({
    id: overrides.id ?? `job-${Math.random()}`,
    project: overrides.project ?? 'app',
    kind: overrides.kind ?? 'agent:improve',
    pid: overrides.pid ?? 1,
    startedAt: overrides.startedAt ?? Math.floor(Date.now() / 1000),
    finishedAt: overrides.finishedAt ?? Math.floor(Date.now() / 1000) + 1,
    exitCode: overrides.exitCode ?? 0,
    seen: overrides.seen ?? false,
    contextMeta: overrides.contextMeta ?? meta('agent-1', 'improve', 'schedule'),
    modifiedFiles: overrides.modifiedFiles ?? null,
    linesAdded: overrides.linesAdded ?? null,
    linesRemoved: overrides.linesRemoved ?? null,
  });
}

function jobValues(overrides: Partial<typeof schema.jobs.$inferInsert> = {}): typeof schema.jobs.$inferInsert {
  return {
    id: overrides.id ?? `job-${Math.random()}`,
    project: overrides.project ?? 'app',
    kind: overrides.kind ?? 'agent:improve',
    pid: overrides.pid ?? 1,
    startedAt: overrides.startedAt ?? Math.floor(Date.now() / 1000),
    finishedAt: overrides.finishedAt ?? Math.floor(Date.now() / 1000) + 1,
    exitCode: overrides.exitCode ?? 0,
    seen: overrides.seen ?? false,
    contextMeta: overrides.contextMeta ?? meta('agent-1', 'improve', 'schedule'),
    modifiedFiles: overrides.modifiedFiles ?? null,
    linesAdded: overrides.linesAdded ?? null,
    linesRemoved: overrides.linesRemoved ?? null,
  };
}

async function insertJobs(rows: Array<typeof schema.jobs.$inferInsert>) {
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    await handle.db.insert(schema.jobs).values(rows.slice(i, i + batchSize));
  }
}

describe('fruitfulness DB loaders', () => {
  it('loadRecentAgentSamples ignores manual runs for the same agent', async () => {
    await insertJob({
      id: 'manual-empty',
      startedAt: 300,
      contextMeta: meta('agent-1', 'improve', 'manual'),
      modifiedFiles: JSON.stringify([]),
      linesAdded: 0,
      linesRemoved: 0,
    });
    await insertJob({
      id: 'scheduled-fruitful',
      startedAt: 200,
      contextMeta: meta('agent-1', 'improve', 'schedule'),
      modifiedFiles: JSON.stringify([{ path: 'src/app.ts' }]),
      linesAdded: 4,
      linesRemoved: 1,
    });

    const { loadRecentAgentSamples, computeFruitfulness } = await import('@/lib/agents/fruitfulness');
    const samples = await loadRecentAgentSamples({
      project: 'app',
      agentId: 'agent-1',
      agentName: 'improve',
      limit: 10,
    });

    expect(samples.map((s) => s.jobId)).toEqual(['scheduled-fruitful']);
    expect(computeFruitfulness(samples)).toMatchObject({ runs: 1, fruitfulRuns: 1, rate: 1 });
  });

  it('loadRecentAgentSamples treats low-confidence dirty-baseline files as non-fruitful', async () => {
    await insertJob({
      id: 'scheduled-dirty-baseline',
      startedAt: 200,
      contextMeta: meta('agent-1', 'improve', 'schedule'),
      modifiedFiles: JSON.stringify([{ path: 'src/pre-existing.ts', confidence: 'low' }]),
      linesAdded: 0,
      linesRemoved: 0,
    });

    const { loadRecentAgentSamples, computeFruitfulness } = await import('@/lib/agents/fruitfulness');
    const samples = await loadRecentAgentSamples({
      project: 'app',
      agentId: 'agent-1',
      agentName: 'improve',
      limit: 10,
    });

    expect(samples.map((s) => s.jobId)).toEqual(['scheduled-dirty-baseline']);
    expect(computeFruitfulness(samples)).toMatchObject({ runs: 1, fruitfulRuns: 0, rate: 0 });
  });

  it('loadRecentAgentSamples is not evicted by a burst of newer manual runs', async () => {
    const rows: Array<typeof schema.jobs.$inferInsert> = [];
    for (let i = 0; i < 250; i++) {
      rows.push(jobValues({
        id: `manual-newer-${i}`,
        startedAt: 10_000 + i,
        contextMeta: meta('agent-1', 'improve', 'manual'),
        modifiedFiles: JSON.stringify([]),
        linesAdded: 0,
        linesRemoved: 0,
      }));
    }
    rows.push(jobValues({
      id: 'scheduled-older-fruitful',
      startedAt: 9_000,
      contextMeta: meta('agent-1', 'improve', 'schedule'),
      modifiedFiles: JSON.stringify([{ path: 'src/app.ts' }]),
      linesAdded: 7,
      linesRemoved: 2,
    }));
    await insertJobs(rows);

    const { loadRecentAgentSamples, computeFruitfulness } = await import('@/lib/agents/fruitfulness');
    const samples = await loadRecentAgentSamples({
      project: 'app',
      agentId: 'agent-1',
      agentName: 'improve',
      limit: 10,
    });

    expect(samples.map((s) => s.jobId)).toEqual(['scheduled-older-fruitful']);
    expect(computeFruitfulness(samples)).toMatchObject({ runs: 1, fruitfulRuns: 1, rate: 1 });
  });

  it('loadRecentAgentSamples is not evicted by newer scheduled runs from sibling agents', async () => {
    const rows: Array<typeof schema.jobs.$inferInsert> = [];
    for (let i = 0; i < 350; i++) {
      rows.push(jobValues({
        id: `sibling-scheduled-newer-${i}`,
        kind: 'agent:cleanup',
        startedAt: 20_000 + i,
        contextMeta: meta('agent-2', 'cleanup', 'schedule'),
        modifiedFiles: JSON.stringify([{ path: `src/cleanup-${i}.ts` }]),
        linesAdded: 1,
        linesRemoved: 0,
      }));
    }
    for (let i = 0; i < 5; i++) {
      rows.push(jobValues({
        id: `target-scheduled-older-${i}`,
        kind: 'agent:improve',
        startedAt: 10_000 + i,
        contextMeta: meta('agent-1', 'improve', 'schedule'),
        modifiedFiles: JSON.stringify([]),
        linesAdded: 0,
        linesRemoved: 0,
      }));
    }
    await insertJobs(rows);

    const { loadRecentAgentSamples, computeFruitfulness } = await import('@/lib/agents/fruitfulness');
    const samples = await loadRecentAgentSamples({
      project: 'app',
      agentId: 'agent-1',
      agentName: 'improve',
      limit: 5,
    });

    expect(samples.map((s) => s.jobId)).toEqual([
      'target-scheduled-older-4',
      'target-scheduled-older-3',
      'target-scheduled-older-2',
      'target-scheduled-older-1',
      'target-scheduled-older-0',
    ]);
    expect(computeFruitfulness(samples)).toMatchObject({ runs: 5, fruitfulRuns: 0, rate: 0 });
  });

  it('loadAllAgentFruitfulness omits agents that only have manual runs', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertJob({
      id: 'agent-1-manual-empty',
      startedAt: now,
      contextMeta: meta('agent-1', 'improve', 'manual'),
      modifiedFiles: JSON.stringify([]),
      linesAdded: 0,
      linesRemoved: 0,
    });
    await insertJob({
      id: 'agent-1-scheduled-fruitful',
      startedAt: now - 1,
      contextMeta: meta('agent-1', 'improve', 'schedule'),
      modifiedFiles: JSON.stringify([{ path: 'src/app.ts' }]),
      linesAdded: 3,
      linesRemoved: 0,
    });
    await insertJob({
      id: 'agent-2-manual-empty',
      kind: 'agent:cleanup',
      startedAt: now - 2,
      contextMeta: meta('agent-2', 'cleanup', 'manual'),
      modifiedFiles: JSON.stringify([]),
      linesAdded: 0,
      linesRemoved: 0,
    });

    const { loadAllAgentFruitfulness } = await import('@/lib/agents/fruitfulness');
    const stats = await loadAllAgentFruitfulness({ limit: 10 });

    expect(stats.get('agent-1')).toMatchObject({ runs: 1, fruitfulRuns: 1, rate: 1 });
    expect(stats.has('agent-2')).toBe(false);
  });

  it('loadAllAgentFruitfulness is not evicted by a workspace-wide burst of newer manual runs', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows: Array<typeof schema.jobs.$inferInsert> = [];
    for (let i = 0; i < 1_050; i++) {
      rows.push(jobValues({
        id: `manual-workspace-${i}`,
        project: i % 2 === 0 ? 'app' : 'other',
        kind: i % 2 === 0 ? 'agent:improve' : 'agent:cleanup',
        startedAt: now - i,
        contextMeta: meta(i % 2 === 0 ? 'agent-1' : 'agent-2', i % 2 === 0 ? 'improve' : 'cleanup', 'manual'),
        modifiedFiles: JSON.stringify([]),
        linesAdded: 0,
        linesRemoved: 0,
      }));
    }
    rows.push(jobValues({
      id: 'agent-1-scheduled-under-manual-burst',
      startedAt: now - 6_000,
      contextMeta: meta('agent-1', 'improve', 'schedule'),
      modifiedFiles: JSON.stringify([{ path: 'src/app.ts' }]),
      linesAdded: 5,
      linesRemoved: 1,
    }));
    await insertJobs(rows);

    const { loadAllAgentFruitfulness } = await import('@/lib/agents/fruitfulness');
    const stats = await loadAllAgentFruitfulness({ limit: 10 });

    expect(stats.get('agent-1')).toMatchObject({ runs: 1, fruitfulRuns: 1, rate: 1 });
    expect(stats.has('agent-2')).toBe(false);
  });

  it('loadAllAgentFruitfulness is not evicted by newer scheduled runs from sibling agents', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows: Array<typeof schema.jobs.$inferInsert> = [];
    for (let i = 0; i < 1_050; i++) {
      rows.push(jobValues({
        id: `sibling-scheduled-workspace-${i}`,
        project: i % 2 === 0 ? 'app' : 'other',
        kind: 'agent:cleanup',
        startedAt: now - i,
        contextMeta: meta('agent-2', 'cleanup', 'schedule'),
        modifiedFiles: JSON.stringify([{ path: `src/cleanup-${i}.ts` }]),
        linesAdded: 1,
        linesRemoved: 0,
      }));
    }
    for (let i = 0; i < 5; i++) {
      rows.push(jobValues({
        id: `agent-1-scheduled-under-sibling-burst-${i}`,
        startedAt: now - 6_000 - i,
        contextMeta: meta('agent-1', 'improve', 'schedule'),
        modifiedFiles: JSON.stringify([]),
        linesAdded: 0,
        linesRemoved: 0,
      }));
    }
    await insertJobs(rows);

    const { loadAllAgentFruitfulness } = await import('@/lib/agents/fruitfulness');
    const { loadBoostAgents } = await import('@/lib/orchestrator/boost-agent-loader');
    const stats = await loadAllAgentFruitfulness({ limit: 5 });
    const agents = await loadBoostAgents({
      listAgents: vi.fn(async () => [
        { id: 'agent-1', name: 'improve', project: 'app', schedule: '15m', prompt: '', enabled: true, kind: 'user' as const, boostable: true, model: 'normal' as const, role: 'producer' as const, autopilot: {} },
      ]),
      getDispatches: vi.fn(() => new Map<string, number>()),
      loadFruitfulness: vi.fn(async () => stats),
    });

    expect(stats.get('agent-1')).toMatchObject({ runs: 5, fruitfulRuns: 0, rate: 0 });
    expect(agents[0].fruitfulness).toEqual({ runs: 5, rate: 0 });
  });
});
