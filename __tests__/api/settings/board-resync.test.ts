import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/types';

const NOW_S = Math.floor(Date.now() / 1000);

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job',
    project: 'proj',
    kind: 'agent:cto',
    prompt: 'p',
    pid: 99999,
    logPath: '/tmp/x.log',
    startedAt: NOW_S - 60,
    finishedAt: NOW_S - 30,
    exitCode: 0,
    seen: true,
    verdict: null,
    contextMeta: null,
    userPrompt: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    releaseId: null,
    abortedAt: null,
    ...overrides,
  };
}

describe('POST /api/settings/board-resync', () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let syncMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listJobsMock = vi.fn();
    syncMock = vi.fn().mockResolvedValue(undefined);
    getSettingsMock = vi.fn(() => ({ github_board_sync_enabled: true }));

    vi.doMock('@/lib/jobs/storage', () => ({ listJobs: listJobsMock }));
    vi.doMock('@/lib/github/project-board', () => ({
      syncJobToProjectBoard: syncMock,
      isBoardSyncRateLimitError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return /rate-limit cooldown active|rate limit exceeded|secondary rate limit|abuse detection/i.test(message);
      },
    }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: getSettingsMock }));

    const mod = await import('@/app/api/settings/board-resync/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function postAndFlush(url = 'http://localhost/api/settings/board-resync') {
    const request = new NextRequest(url, { method: 'POST' });
    const responsePromise = POST(request);
    await vi.runAllTimersAsync();
    return responsePromise;
  }

  it('returns 409 when board sync is disabled', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ github_board_sync_enabled: false });
    const res = await postAndFlush();
    expect(res.status).toBe(409);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('resyncs jobs within the default window and skips pipeline children', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([
      makeJob({ id: 'agent-1', kind: 'agent:cto' }),
      makeJob({ id: 'release-1', kind: 'release' }),
      makeJob({ id: 'review-1', kind: 'review', releaseId: 'release-1' }),
      makeJob({ id: 'fix-1', kind: 'fix', parentJobId: 'review-1' }),
      makeJob({ id: 'old-1', kind: 'agent:cto', startedAt: NOW_S - 30 * 24 * 3600, finishedAt: NOW_S - 30 * 24 * 3600 }),
      makeJob({ id: 'run-1', kind: 'run' }),
    ]);

    const res = await postAndFlush();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.days).toBe(7);
    expect(data.scanned).toBe(3);
    expect(data.resynced).toBe(3);
    expect(data.failed).toBe(0);

    const syncedIds = syncMock.mock.calls.map(([job]) => (job as JobData).id).sort();
    expect(syncedIds).toEqual(['agent-1', 'release-1', 'run-1']);
    for (const call of syncMock.mock.calls) {
      expect(call[1]).toBe('manual');
      expect(call[2]).toEqual({ requireConfigured: true });
    }
  });

  it('stops early when a rate-limit error is hit', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a' }),
      makeJob({ id: 'b' }),
      makeJob({ id: 'c' }),
      makeJob({ id: 'd' }),
    ]);
    syncMock.mockImplementation(async (job: JobData) => {
      if (job.id === 'c') throw new Error('GitHub board sync skipped: rate-limit cooldown active');
    });

    const data = await (await postAndFlush()).json();
    expect(data.resynced).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.rateLimited).toBe(true);
    // Loop must not invoke sync for the job after the rate-limited one.
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it('stops early when GitHub abuse detection asks for backoff', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a' }),
      makeJob({ id: 'b' }),
      makeJob({ id: 'c' }),
      makeJob({ id: 'd' }),
    ]);
    syncMock.mockImplementation(async (job: JobData) => {
      if (job.id === 'c') throw new Error('GraphQL error: abuse detection mechanism triggered');
    });

    const data = await (await postAndFlush()).json();
    expect(data.resynced).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.rateLimited).toBe(true);
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it('counts failures without aborting the loop', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([
      makeJob({ id: 'a' }),
      makeJob({ id: 'b' }),
      makeJob({ id: 'c' }),
    ]);
    syncMock.mockImplementation(async (job: JobData) => {
      if (job.id === 'b') throw new Error('parse failure');
    });

    const res = await postAndFlush();
    const data = await res.json();
    expect(data.resynced).toBe(2);
    expect(data.failed).toBe(1);
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it('respects the days query parameter and clamps to 90', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([]);
    const data1 = await (await postAndFlush('http://localhost/api/settings/board-resync?days=14')).json();
    expect(data1.days).toBe(14);

    const data2 = await (await postAndFlush('http://localhost/api/settings/board-resync?days=500')).json();
    expect(data2.days).toBe(90);

    const data3 = await (await postAndFlush('http://localhost/api/settings/board-resync?days=0')).json();
    expect(data3.days).toBe(7);
  });

  it('respects the limit query parameter and processes newest jobs first', async () => {
    vi.useFakeTimers();
    listJobsMock.mockReturnValue([
      makeJob({ id: 'oldest', startedAt: NOW_S - 90 }),
      makeJob({ id: 'newest', startedAt: NOW_S - 10 }),
      makeJob({ id: 'middle', startedAt: NOW_S - 40 }),
    ]);

    const data = await (await postAndFlush('http://localhost/api/settings/board-resync?limit=2')).json();

    expect(data.limit).toBe(2);
    expect(data.scanned).toBe(2);
    expect(data.resynced).toBe(2);
    expect(syncMock.mock.calls.map(([job]) => (job as JobData).id)).toEqual(['newest', 'middle']);
  });
});

describe('POST /api/settings/board-resync legacy upgrade path', () => {
  afterEach(() => vi.resetModules());

  it('resyncs successfully when existing settings still use the legacy board status map', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/github/project-board');

    const job = makeJob({ id: 'legacy-agent-1' });
    const execMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              id: 'FIELD_1',
              name: 'Status',
              options: [
                { id: 'OT', name: 'Todo' },
                { id: 'OP', name: 'In Progress' },
                { id: 'NREV', name: 'Review' },
                { id: 'NFIX', name: 'Fixing' },
                { id: 'NBLK', name: 'Blocked' },
                { id: 'OD', name: 'Done' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'project' && args[1] === 'field-create') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx >= 0 ? args[nameIdx + 1] : '';
        const id = `F_${name.replace(/\s+/g, '_').toUpperCase()}`;
        return { exitCode: 0, stdout: JSON.stringify({ id, name }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_LEGACY' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    const dbRunMock = vi.fn();
    const dbInsertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({ run: dbRunMock })),
      })),
    }));
    const updateJobMock = vi.fn();

    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: vi.fn((id: string) => (id === job.id ? job : null)),
      listJobs: vi.fn(() => [job]),
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: 'octocat',
        github_board_sync_enabled: true,
        github_board_project_owner: 'octocat',
        github_board_project_title: 'TamTam',
        github_board_project_number: '7',
        github_board_project_url: '',
        github_board_project_id: 'PVT_1',
        github_board_status_field_id: 'FIELD_1',
        github_board_status_option_ids: {
          Queued: 'OLD_Q',
          Running: 'OLD_R',
          Review: 'OLD_REV',
          Fixing: 'OLD_F',
          'Ready to Push': 'OLD_PUSH',
          Blocked: 'OLD_B',
          Done: 'OLD_D',
          Failed: 'OLD_X',
        },
        github_board_custom_field_ids: {},
      }),
      reloadConfig: vi.fn(),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn(() => '/tmp/repo'),
    }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: { insert: dbInsertMock },
      schema: { settings: { key: 'key' } },
    }));

    const POST = (await import('@/app/api/settings/board-resync/route')).POST;
    const res = await POST(new NextRequest('http://localhost/api/settings/board-resync', { method: 'POST' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, scanned: 1, resynced: 1, failed: 0, rateLimited: false });
    expect(dbInsertMock).toHaveBeenCalledTimes(8);
    expect(updateJobMock).toHaveBeenCalled();
  });
});
