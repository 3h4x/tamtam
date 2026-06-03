import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';
import { formatRunFeedbackBlock, type RunOutcome } from '@/lib/agents/run-feedback';

function outcome(o: Partial<RunOutcome> = {}): RunOutcome {
  return {
    startedAt: o.startedAt ?? 100,
    exitCode: o.exitCode ?? 0,
    fruitful: o.fruitful ?? false,
    summary: o.summary ?? null,
  };
}

describe('formatRunFeedbackBlock', () => {
  it('returns null when there are no runs', () => {
    expect(formatRunFeedbackBlock([])).toBeNull();
  });

  it('returns null when the agent is producing changes often enough', () => {
    const block = formatRunFeedbackBlock([
      outcome({ fruitful: true }),
      outcome({ fruitful: true }),
      outcome({ fruitful: false }),
    ]);
    expect(block).toBeNull();
  });

  it('summarizes a low-yield pattern with per-run detail', () => {
    const block = formatRunFeedbackBlock([
      outcome({ fruitful: false, summary: 'Checked UI layer; no actionable target.' }),
      outcome({ fruitful: false, summary: 'Nothing to consolidate this pass.' }),
      outcome({ fruitful: false }),
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain('produced changes in only 0 of its last 3 runs');
    expect(block).toContain('no actionable target');
    expect(block).toMatch(/Run 1 \(no changes/);
  });
});

describe('loadRecentRunOutcomes', () => {
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

  function meta(agentId: string, agentName: string) {
    return JSON.stringify({ agent: { id: agentId, name: agentName, triggeredBy: 'schedule' } });
  }

  function legacyMeta(agentName: string) {
    return JSON.stringify({ agent: { name: agentName, triggeredBy: 'schedule' }, sourceJobId: 'legacy-source' });
  }

  async function insertJob(overrides: Partial<typeof schema.jobs.$inferInsert> = {}) {
    await handle.db.insert(schema.jobs).values({
      id: overrides.id ?? `job-${Math.random()}`,
      project: overrides.project ?? 'app',
      kind: overrides.kind ?? 'agent:improve',
      pid: overrides.pid ?? 1,
      startedAt: overrides.startedAt ?? 100,
      finishedAt: overrides.finishedAt ?? 200,
      exitCode: overrides.exitCode ?? 0,
      seen: overrides.seen ?? false,
      contextMeta: overrides.contextMeta ?? meta('agent-1', 'improve'),
      workSummary: overrides.workSummary ?? null,
      modifiedFiles: overrides.modifiedFiles ?? null,
      linesAdded: overrides.linesAdded ?? null,
      linesRemoved: overrides.linesRemoved ?? null,
    });
  }

  it('returns the target agent runs newest-first and marks fruitfulness', async () => {
    const { loadRecentRunOutcomes } = await import('@/lib/agents/run-feedback');
    await insertJob({ id: 'old', startedAt: 100, workSummary: 'empty pass' });
    await insertJob({
      id: 'new',
      startedAt: 300,
      workSummary: 'changed a file',
      modifiedFiles: JSON.stringify([{ path: 'a.ts', status: 'M' }]),
      linesAdded: 5,
    });
    // A different agent in the same project must not leak in.
    await insertJob({ id: 'other', startedAt: 400, contextMeta: meta('agent-2', 'other'), kind: 'agent:other' });

    const out = await loadRecentRunOutcomes({ project: 'app', agentId: 'agent-1', agentName: 'improve' });
    expect(out.map((o) => o.startedAt)).toEqual([300, 100]);
    expect(out[0].fruitful).toBe(true);
    expect(out[1].fruitful).toBe(false);
    expect(out[1].summary).toBe('empty pass');
  });

  it('filters by target agent before pagination so newer sibling runs cannot crowd it out', async () => {
    const { loadRecentRunOutcomes } = await import('@/lib/agents/run-feedback');
    await insertJob({ id: 'target-old', startedAt: 100, workSummary: 'target pass' });

    for (let i = 0; i < 30; i++) {
      await insertJob({
        id: `sibling-${i}`,
        startedAt: 1_000 + i,
        contextMeta: meta('agent-2', 'other'),
        kind: 'agent:other',
        workSummary: `sibling pass ${i}`,
        modifiedFiles: JSON.stringify([{ path: `file-${i}.ts`, status: 'M' }]),
        linesAdded: 1,
      });
    }

    const out = await loadRecentRunOutcomes({ project: 'app', agentId: 'agent-1', agentName: 'improve' });
    expect(out).toHaveLength(1);
    expect(out[0].startedAt).toBe(100);
    expect(out[0].summary).toBe('target pass');
  });

  it('includes name-only legacy rows when an agent id is also provided', async () => {
    const { loadRecentRunOutcomes } = await import('@/lib/agents/run-feedback');
    await insertJob({
      id: 'legacy-name-only',
      startedAt: 200,
      contextMeta: legacyMeta('improve'),
      workSummary: 'Legacy row found work but landed nothing.',
    });
    await insertJob({
      id: 'current-id',
      startedAt: 300,
      workSummary: 'Current row also landed nothing.',
    });
    await insertJob({
      id: 'different-id-same-name',
      startedAt: 400,
      contextMeta: meta('agent-2', 'improve'),
      workSummary: 'Different recreated agent must not leak in.',
    });

    const out = await loadRecentRunOutcomes({ project: 'app', agentId: 'agent-1', agentName: 'improve' });
    expect(out.map((o) => o.summary)).toEqual([
      'Current row also landed nothing.',
      'Legacy row found work but landed nothing.',
    ]);
  });

  it('does not let same-name rows with a different id crowd out legacy fallback rows', async () => {
    const { loadRecentRunOutcomes } = await import('@/lib/agents/run-feedback');
    await insertJob({
      id: 'legacy-target',
      startedAt: 100,
      contextMeta: legacyMeta('improve'),
      workSummary: 'Legacy target still matters.',
    });

    for (let i = 0; i < 30; i++) {
      await insertJob({
        id: `same-name-other-id-${i}`,
        startedAt: 1_000 + i,
        contextMeta: meta('agent-2', 'improve'),
        workSummary: `Different id same name ${i}`,
        modifiedFiles: JSON.stringify([{ path: `other-${i}.ts`, status: 'M' }]),
        linesAdded: 1,
      });
    }

    const out = await loadRecentRunOutcomes({ project: 'app', agentId: 'agent-1', agentName: 'improve' });
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe('Legacy target still matters.');
  });

  it('uses the shared fruitfulness rule for low-confidence modified files', async () => {
    const { loadRecentRunOutcomes } = await import('@/lib/agents/run-feedback');
    await insertJob({
      id: 'low-confidence-only',
      modifiedFiles: JSON.stringify([{ path: 'noise.log', status: 'M', confidence: 'low' }]),
      linesAdded: 0,
      linesRemoved: 0,
    });

    const out = await loadRecentRunOutcomes({ project: 'app', agentId: 'agent-1', agentName: 'improve' });
    expect(out).toHaveLength(1);
    expect(out[0].fruitful).toBe(false);
  });
});
