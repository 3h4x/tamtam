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
});
