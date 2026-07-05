// __tests__/orchestrator/initiative-dispatch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchTopInitiative } from '@/lib/orchestrator/initiative-dispatch';
import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

function row(over: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 1, project: 'proj', source: 'mining', kind: 'lint', title: 't', rationale: 'r',
    prompt: 'p', score: 100, status: 'queued', dedupKey: 'd', releaseId: null,
    attempts: 0, cooldownUntil: null, pinnedAt: null, createdAt: 0, updatedAt: 0, ...over,
  };
}

function baseDeps(over: Partial<Parameters<typeof dispatchTopInitiative>[1]> = {}) {
  return {
    listQueued: vi.fn(async () => [row()]),
    setStatus: vi.fn(async () => {}),
    gatesClear: () => true,
    projectBusy: () => false,
    shipsToday: () => 0,
    maxShipsPerDay: 3,
    runInitiative: vi.fn(async () => {}),
    now: () => 1000,
    ...over,
  };
}

describe('dispatchTopInitiative', () => {
  it('dispatches the top-scored queued initiative', async () => {
    const deps = baseDeps({
      listQueued: vi.fn(async () => [row({ id: 1, score: 10 }), row({ id: 2, score: 90 })]),
    });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.dispatched?.id).toBe(2);
    expect(deps.setStatus).toHaveBeenCalledWith(2, 'running', { bumpAttempts: true }, 1000);
    expect(deps.runInitiative).toHaveBeenCalledTimes(1);
  });

  it('dispatches a pinned initiative ahead of a higher-scored unpinned one', async () => {
    const deps = baseDeps({
      listQueued: vi.fn(async () => [row({ id: 1, score: 90 }), row({ id: 2, score: 10, pinnedAt: 5 })]),
    });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.dispatched?.id).toBe(2);
  });

  it('skips when gates are not clear', async () => {
    const deps = baseDeps({ gatesClear: () => false });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res).toEqual({ dispatched: null, skipped: 'gates' });
    expect(deps.runInitiative).not.toHaveBeenCalled();
  });

  it('skips when ships/day cap reached', async () => {
    const deps = baseDeps({ shipsToday: () => 3, maxShipsPerDay: 3 });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('ships-cap');
  });

  it('skips when the project is busy', async () => {
    const deps = baseDeps({ projectBusy: () => true });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('busy');
  });

  it('supports async project busy checks', async () => {
    const deps = baseDeps({ projectBusy: vi.fn(async () => true) });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('busy');
    expect(deps.runInitiative).not.toHaveBeenCalled();
  });

  it('skips with ci-red when the default-branch CI gate reports red', async () => {
    const deps = baseDeps({ ciRed: () => true });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res).toEqual({ dispatched: null, skipped: 'ci-red' });
    expect(deps.runInitiative).not.toHaveBeenCalled();
  });

  it('supports async ci-red checks', async () => {
    const deps = baseDeps({ ciRed: vi.fn(async () => true) });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('ci-red');
    expect(deps.runInitiative).not.toHaveBeenCalled();
  });

  it('returns empty without calling ciRed when the backlog is empty (gh call avoided)', async () => {
    const ciRed = vi.fn(() => true);
    const deps = baseDeps({ listQueued: vi.fn(async () => []), ciRed });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('empty');
    expect(ciRed).not.toHaveBeenCalled();
  });

  it('dispatches normally when ciRed is not provided (backward compatible)', async () => {
    const deps = baseDeps(); // no ciRed dep
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.dispatched).not.toBeNull();
  });

  it('skips when the backlog is empty', async () => {
    const deps = baseDeps({ listQueued: vi.fn(async () => []) });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res.skipped).toBe('empty');
  });

  it('returns a queued initiative to queued state without marking it failed', async () => {
    const deps = baseDeps({
      runInitiative: vi.fn(async () => ({ status: 'queued' as const, detail: 'pipeline lock' })),
    });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res).toEqual({ dispatched: null, skipped: 'queued' });
    expect(deps.setStatus).toHaveBeenNthCalledWith(1, 1, 'running', { bumpAttempts: true }, 1000);
    expect(deps.setStatus).toHaveBeenNthCalledWith(2, 1, 'queued', { cooldownUntil: 61_000 }, 1000);
    expect(deps.setStatus).toHaveBeenCalledTimes(2);
  });

  it('marks failed with cooldown when runInitiative throws', async () => {
    const deps = baseDeps({ runInitiative: vi.fn(async () => { throw new Error('boom'); }) });
    const res = await dispatchTopInitiative('proj', deps);
    expect(res).toEqual({ dispatched: null, skipped: null });
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      1, 'failed', { cooldownUntil: 1000 + 6 * 3600 * 1000 }, 1000,
    );
  });
});
