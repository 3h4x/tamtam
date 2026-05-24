import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readLocalStepFiles', () => {
  afterEach(() => {
    vi.doUnmock('fs');
    vi.resetModules();
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
  });

  it('returns an empty list when the local steps directory is missing at read time', async () => {
    const readdirSyncMock = vi.fn(() => {
      const err = new Error('missing') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        readdirSync: readdirSyncMock,
      };
    });

    process.env.WORKFLOW_LOCAL_DATA_DIR = '/tmp/tamtam-local-world-test';

    const { readLocalStepFiles } = await import('@/lib/workflows/local-world-runs');

    expect(readLocalStepFiles('wrun_1')).toEqual([]);
    expect(readdirSyncMock).toHaveBeenCalledOnce();
  });

  it('skips a local step file that disappears after directory listing', async () => {
    const readdirSyncMock = vi.fn(() => ['wrun_1-step-a.json', 'wrun_1-step-b.json']);
    const readFileSyncMock = vi.fn((path: string) => {
      if (path.endsWith('wrun_1-step-a.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.stringify({
        runId: 'wrun_1',
        stepId: 'step-b',
        stepName: 'workflow//review',
        status: 'completed',
        createdAt: '2026-05-23T10:00:00.000Z',
      });
    });

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        readdirSync: readdirSyncMock,
        readFileSync: readFileSyncMock,
      };
    });

    process.env.WORKFLOW_LOCAL_DATA_DIR = '/tmp/tamtam-local-world-test';

    const { readLocalStepFiles } = await import('@/lib/workflows/local-world-runs');

    expect(readLocalStepFiles('wrun_1')).toEqual([
      {
        runId: 'wrun_1',
        stepId: 'step-b',
        stepName: 'workflow//review',
        status: 'completed',
        createdAt: '2026-05-23T10:00:00.000Z',
      },
    ]);
  });
});

describe('listLocalRunFilesNewestFirst', () => {
  afterEach(() => {
    vi.doUnmock('fs');
    vi.resetModules();
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
  });

  it('keeps only the newest run files while scanning', async () => {
    const readdirSyncMock = vi.fn(() => [
      'old.json',
      'ignore.txt',
      'newest.json',
      'middle.json',
      'newer.json',
    ]);
    const mtimes = new Map([
      ['old.json', 10],
      ['newest.json', 40],
      ['middle.json', 20],
      ['newer.json', 30],
    ]);
    const statSyncMock = vi.fn((path: string) => ({
      mtimeMs: mtimes.get(path.split('/').pop() ?? '') ?? 0,
    }));

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        readdirSync: readdirSyncMock,
        statSync: statSyncMock,
      };
    });

    process.env.WORKFLOW_LOCAL_DATA_DIR = '/tmp/tamtam-local-world-test';

    const { listLocalRunFilesNewestFirst } = await import('@/lib/workflows/local-world-runs');

    expect(listLocalRunFilesNewestFirst(2)).toEqual([
      { name: 'newest.json', mtime: 40 },
      { name: 'newer.json', mtime: 30 },
    ]);
    expect(statSyncMock).toHaveBeenCalledTimes(4);
  });
});
