import { describe, it, expect, vi } from 'vitest';
import { reconcileRunningInitiatives } from '@/lib/orchestrator/initiative-reconcile';
import type { LinkedJobKind, ReconcileDeps, RunOutcome } from '@/lib/orchestrator/initiative-reconcile';
import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

function makeRow(overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 1,
    project: 'proj',
    source: 'mining',
    kind: 'lint',
    title: 't',
    rationale: 'r',
    prompt: 'Fix lint.',
    score: 100,
    status: 'running',
    dedupKey: 'd',
    releaseId: 'job-1',
    attempts: 1,
    cooldownUntil: null,
    pinnedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeDeps(
  rows: InitiativeRow[],
  outcomes: Record<string, RunOutcome>,
  kinds: Record<string, LinkedJobKind> = {},
): { deps: ReconcileDeps; markOutcome: ReturnType<typeof vi.fn> } {
  const markOutcome = vi.fn(async () => undefined);
  const deps: ReconcileDeps = {
    listRunning: vi.fn(async () => rows),
    jobStatus: vi.fn(async (jobId: string) => outcomes[jobId] ?? 'unknown'),
    jobKind: vi.fn((jobId: string) => kinds[jobId] ?? 'release'),
    markOutcome,
  };
  return { deps, markOutcome };
}

describe('reconcileRunningInitiatives', () => {
  it('marks shipped when job outcome is success', async () => {
    const row = makeRow({ releaseId: 'job-success' });
    const { deps, markOutcome } = makeDeps([row], { 'job-success': 'success' });

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(1, 'shipped', 'job-success');
  });

  it('leaves initiative running when the linked agent job succeeds before a release starts', async () => {
    const row = makeRow({ releaseId: 'agent-success' });
    const { deps, markOutcome } = makeDeps(
      [row],
      { 'agent-success': 'success' },
      { 'agent-success': 'agent' },
    );

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('marks shipped only after the linked release job succeeds', async () => {
    const row = makeRow({ releaseId: 'release-success' });
    const { deps, markOutcome } = makeDeps(
      [row],
      { 'release-success': 'success' },
      { 'release-success': 'release' },
    );

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(1, 'shipped', 'release-success');
  });

  it('marks failed when job outcome is failed', async () => {
    const row = makeRow({ releaseId: 'job-fail' });
    const { deps, markOutcome } = makeDeps([row], { 'job-fail': 'failed' });

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(1, 'failed', 'job-fail');
  });

  it('leaves initiative untouched when job is still running', async () => {
    const row = makeRow({ releaseId: 'job-running' });
    const { deps, markOutcome } = makeDeps([row], { 'job-running': 'running' });

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('leaves initiative untouched when job outcome is unknown', async () => {
    const row = makeRow({ releaseId: 'job-x' });
    const { deps, markOutcome } = makeDeps([row], { 'job-x': 'unknown' });

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('leaves initiative untouched when releaseId is null', async () => {
    const row = makeRow({ releaseId: null });
    const { deps, markOutcome } = makeDeps([row], {});

    await reconcileRunningInitiatives('proj', deps);

    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('marks failed when job outcome is unknown and initiative is stale', async () => {
    const now = 1_000_000;
    const staleMs = 60_000;
    const row = makeRow({ releaseId: 'job-x', updatedAt: now - staleMs - 1 });
    const { deps, markOutcome } = makeDeps([row], { 'job-x': 'unknown' });

    await reconcileRunningInitiatives('proj', { ...deps, now: () => now, staleMs });

    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(1, 'failed', 'job-x');
  });

  it('leaves initiative untouched when job outcome is unknown but not yet stale', async () => {
    const now = 1_000_000;
    const staleMs = 60_000;
    const row = makeRow({ releaseId: 'job-x', updatedAt: now - staleMs + 1 });
    const { deps, markOutcome } = makeDeps([row], { 'job-x': 'unknown' });

    await reconcileRunningInitiatives('proj', { ...deps, now: () => now, staleMs });

    expect(markOutcome).not.toHaveBeenCalled();
  });

  it('marks failed when releaseId is null and initiative is stale', async () => {
    const now = 1_000_000;
    const staleMs = 60_000;
    const row = makeRow({ releaseId: null, updatedAt: now - staleMs - 1 });
    const { deps, markOutcome } = makeDeps([row], {});

    await reconcileRunningInitiatives('proj', { ...deps, now: () => now, staleMs });

    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(1, 'failed', null);
  });

  it('continues reconciling other initiatives when one throws', async () => {
    const rowA = makeRow({ id: 1, releaseId: 'job-a' });
    const rowB = makeRow({ id: 2, releaseId: 'job-b' });
    const markOutcome = vi.fn(async () => undefined);
    const deps: ReconcileDeps = {
      listRunning: vi.fn(async () => [rowA, rowB]),
      jobStatus: vi.fn(async (jobId: string): Promise<RunOutcome> => {
        if (jobId === 'job-a') throw new Error('status lookup failed');
        return 'success';
      }),
      markOutcome,
    };

    await reconcileRunningInitiatives('proj', deps);

    // rowA threw — rowB should still be marked shipped
    expect(markOutcome).toHaveBeenCalledOnce();
    expect(markOutcome).toHaveBeenCalledWith(2, 'shipped', 'job-b');
  });
});
