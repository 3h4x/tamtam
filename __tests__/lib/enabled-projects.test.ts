import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listEnabledProjects', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('uses the filtered query path when available', async () => {
    const rows = [
      { name: 'proj1', path: '/w/proj1', enabled: true },
      { name: 'proj2', path: '/w/proj2', enabled: false },
    ];
    const all = vi.fn().mockReturnValue(rows);
    const where = vi.fn().mockReturnValue({ all, then: (r: (v: unknown) => unknown) => r(rows) });
    const from = vi.fn().mockReturnValue({
      where,
      all,
      then: (r: (v: unknown) => unknown) => r(rows),
    });
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { listEnabledProjects, refreshProjectsCacheSync } = await import(
      '@/lib/shared/enabled-projects'
    );
    await refreshProjectsCacheSync();
    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1', archived: false }),
    ]);
  });

  it('falls back to an unfiltered scan when the where-chain is unavailable', async () => {
    const rows = [
      { name: 'proj1', path: '/w/proj1', enabled: true },
      { name: 'proj2', path: '/w/proj2', enabled: false },
    ];
    const all = vi.fn().mockReturnValue(rows);
    const from = vi.fn().mockReturnValue({ all, then: (r: (v: unknown) => unknown) => r(rows) });
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { listEnabledProjects, refreshProjectsCacheSync } = await import(
      '@/lib/shared/enabled-projects'
    );
    await refreshProjectsCacheSync();
    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1', archived: false }),
    ]);
  });

  it('returns an empty list when the projects table is unavailable', async () => {
    vi.doMock('@/lib/db', () => ({
      db: { select: vi.fn() },
      schema: {},
    }));

    const { listEnabledProjects, refreshProjectsCacheSync } = await import(
      '@/lib/shared/enabled-projects'
    );
    await refreshProjectsCacheSync();
    expect(listEnabledProjects()).toEqual([]);
  });

  it('keeps lazy refresh working after a synchronous refresh waits on an in-flight refresh', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let rows = [
      { name: 'proj1', path: '/w/proj1', enabled: true },
    ];
    let resolveFirst!: (value: typeof rows) => void;
    const from = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof rows>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementation(() => Promise.resolve(rows));
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { listEnabledProjects, refreshProjectsCacheSync } = await import(
      '@/lib/shared/enabled-projects'
    );

    expect(listEnabledProjects()).toEqual([]);
    const joinedRefresh = refreshProjectsCacheSync();
    expect(select).toHaveBeenCalledTimes(1);
    resolveFirst(rows);
    await joinedRefresh;

    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1' }),
    ]);
    expect(select).toHaveBeenCalledTimes(2);

    rows = [
      { name: 'proj2', path: '/w/proj2', enabled: true },
    ];
    dateNow.mockReturnValue(12_000);

    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(3);
    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj2', path: '/w/proj2' }),
    ]);
  });

  it('forces a fresh synchronous refresh after an in-flight stale lazy refresh', async () => {
    const staleRows = [
      { name: 'proj1', path: '/w/proj1', enabled: true, paused: false, archived: false },
    ];
    const freshRows = [
      { name: 'proj1', path: '/w/proj1', enabled: true, paused: true, archived: true },
    ];
    let resolveStale!: (value: typeof staleRows) => void;
    const from = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof staleRows>((resolve) => {
        resolveStale = resolve;
      }))
      .mockResolvedValue(freshRows);
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { isProjectArchived, isProjectPaused, listEnabledProjects, refreshProjectsCacheSync } = await import(
      '@/lib/shared/enabled-projects'
    );

    expect(listEnabledProjects()).toEqual([]);
    const refresh = refreshProjectsCacheSync();
    expect(select).toHaveBeenCalledTimes(1);
    resolveStale(staleRows);
    await refresh;

    expect(select).toHaveBeenCalledTimes(2);
    expect(isProjectPaused('proj1')).toBe(true);
    expect(isProjectArchived('proj1')).toBe(true);
  });
});
