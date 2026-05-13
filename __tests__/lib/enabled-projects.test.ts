import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listEnabledProjects', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('uses the filtered query path when available', async () => {
    const all = vi.fn().mockReturnValue([
      { name: 'proj1', path: '/w/proj1', enabled: true },
      { name: 'proj2', path: '/w/proj2', enabled: false },
    ]);
    const where = vi.fn().mockReturnValue({ all });
    const from = vi.fn().mockReturnValue({ where, all });
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1', archived: false }),
    ]);
  });

  it('falls back to an unfiltered scan when the where-chain is unavailable', async () => {
    const all = vi.fn().mockReturnValue([
      { name: 'proj1', path: '/w/proj1', enabled: 1 },
      { name: 'proj2', path: '/w/proj2', enabled: 0 },
    ]);
    const from = vi.fn().mockReturnValue({ all });
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('@/lib/db', () => ({
      db: { select },
      schema: { projects: { enabled: 'enabled' } },
    }));

    const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
    expect(listEnabledProjects()).toEqual([
      expect.objectContaining({ name: 'proj1', path: '/w/proj1', archived: false }),
    ]);
  });

  it('returns an empty list when the projects table is unavailable', async () => {
    vi.doMock('@/lib/db', () => ({
      db: { select: vi.fn() },
      schema: {},
    }));

    const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
    expect(listEnabledProjects()).toEqual([]);
  });
});
