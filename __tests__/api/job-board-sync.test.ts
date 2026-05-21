import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('POST /api/jobs/[jobId]/board-sync', () => {
  const getJobMock = vi.fn();
  const syncJobToProjectBoardMock = vi.fn();
  const isBoardSyncRateLimitErrorMock = vi.fn().mockReturnValue(false);
  let POST: typeof import('@/app/api/jobs/[jobId]/board-sync/route').POST;

  beforeEach(async () => {
    vi.resetModules();
    getJobMock.mockReset();
    syncJobToProjectBoardMock.mockReset();
    isBoardSyncRateLimitErrorMock.mockReset();
    isBoardSyncRateLimitErrorMock.mockReturnValue(false);
    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
    }));
    vi.doMock('@/lib/github/project-board', () => ({
      syncJobToProjectBoard: syncJobToProjectBoardMock,
      isBoardSyncRateLimitError: isBoardSyncRateLimitErrorMock,
    }));
    POST = (await import('@/app/api/jobs/[jobId]/board-sync/route')).POST;
  });

  it('returns 404 when the job does not exist', async () => {
    getJobMock.mockReturnValue(null);
    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(404);
  });

  it('re-syncs an existing job', async () => {
    const job = { id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 };
    getJobMock.mockReturnValue(job);

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(200);
    expect(syncJobToProjectBoardMock).toHaveBeenCalledWith(job, 'manual', { requireConfigured: true });
  });

  it('rejects running jobs', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: null, exitCode: null });

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ detail: 'Only finished jobs can be synced manually.' });
    expect(syncJobToProjectBoardMock).not.toHaveBeenCalled();
  });

  it('surfaces configuration errors', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 });
    syncJobToProjectBoardMock.mockRejectedValueOnce(new Error('GitHub board sync is disabled.'));

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ detail: 'GitHub board sync is disabled.' });
  });

  it('surfaces downstream sync failures', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 });
    syncJobToProjectBoardMock.mockRejectedValueOnce(new Error('gh project item-edit failed'));

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ detail: 'gh project item-edit failed' });
  });

  it('returns 429 when the project-board layer signals a rate-limit cooldown', async () => {
    getJobMock.mockReturnValue({ id: 'job-1', project: 'proj', kind: 'run', finishedAt: 123, exitCode: 0 });
    // The real error message also starts with "GitHub board sync " which
    // would otherwise be matched as a 409 config-state error — the route
    // must consult isBoardSyncRateLimitError() first so the back-off
    // signal reaches clients.
    syncJobToProjectBoardMock.mockRejectedValueOnce(new Error('GitHub board sync skipped: rate-limit cooldown active'));
    isBoardSyncRateLimitErrorMock.mockReturnValueOnce(true);

    const response = await POST(new NextRequest('http://localhost/api/jobs/job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });

    expect(response.status).toBe(429);
  });
});

describe('POST /api/jobs/[jobId]/board-sync legacy upgrade path', () => {
  it('auto-heals legacy board settings and succeeds through the real sync helper', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/github/project-board');

    const job = {
      id: 'legacy-job-1',
      project: 'proj',
      kind: 'run',
      prompt: 'heal legacy board config',
      pid: 99999,
      logPath: '/tmp/job.log',
      startedAt: 10,
      finishedAt: 20,
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
    };

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
    const dbExecuteMock = vi.fn(async () => ({ rowCount: 1 }));
    const dbInsertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({ execute: dbExecuteMock })),
      })),
    }));
    const updateJobMock = vi.fn();

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: vi.fn(() => job),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: vi.fn((id: string) => (id === job.id ? job : null)),
      listJobs: vi.fn(() => []),
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

    const POST = (await import('@/app/api/jobs/[jobId]/board-sync/route')).POST;
    const response = await POST(new NextRequest('http://localhost/api/jobs/legacy-job-1/board-sync', { method: 'POST' }), {
      params: Promise.resolve({ jobId: 'legacy-job-1' }),
    });

    expect(response.status).toBe(200);
    expect(dbInsertMock).toHaveBeenCalledTimes(8);
    expect(updateJobMock).toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith('gh', expect.arrayContaining(['project', 'field-create', '7']), { timeout: 30000 });
  });
});
