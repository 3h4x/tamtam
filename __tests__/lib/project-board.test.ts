import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj',
    kind: 'run',
    prompt: 'Ship it',
    pid: 1,
    logPath: '/tmp/job.log',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
    seen: false,
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

describe('project board integration', () => {
  const execMock = vi.fn();
  const updateJobMock = vi.fn();
  const getJobMock = vi.fn();
  const resolveProjectPathMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    updateJobMock.mockReset();
    getJobMock.mockReset();
    resolveProjectPathMock.mockReset();

    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: getJobMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: '',
        github_board_sync_enabled: false,
        github_board_project_owner: '',
        github_board_project_title: 'TamTam',
        github_board_project_number: '',
        github_board_project_id: '',
        github_board_status_field_id: '',
        github_board_status_option_ids: {},
      }),
    }));
  });

  it('reuses an existing GitHub project and status field when provisioning', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              id: 'FIELD_1',
              name: 'TamTam Status',
              options: [
                { id: 'Q', name: 'Queued' },
                { id: 'R', name: 'Running' },
                { id: 'REV', name: 'Review' },
                { id: 'F', name: 'Fixing' },
                { id: 'P', name: 'Ready to Push' },
                { id: 'B', name: 'Blocked' },
                { id: 'D', name: 'Done' },
                { id: 'X', name: 'Failed' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    const result = await ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' });

    expect(result).toEqual({
      owner: 'octocat',
      title: 'TamTam',
      projectNumber: '7',
      projectId: 'PVT_1',
      statusFieldId: 'FIELD_1',
      optionIds: {
        Queued: 'Q',
        Running: 'R',
        Review: 'REV',
        Fixing: 'F',
        'Ready to Push': 'P',
        Blocked: 'B',
        Done: 'D',
        Failed: 'X',
      },
    });
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('creates the project and status field when they do not exist', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'PVT_NEW', number: 9, title: 'TamTam Ops' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return { exitCode: 0, stdout: JSON.stringify({ fields: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-create') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'FIELD_NEW',
            name: 'TamTam Status',
            options: [
              { id: 'Q', name: 'Queued' },
              { id: 'R', name: 'Running' },
              { id: 'REV', name: 'Review' },
              { id: 'F', name: 'Fixing' },
              { id: 'P', name: 'Ready to Push' },
              { id: 'B', name: 'Blocked' },
              { id: 'D', name: 'Done' },
              { id: 'X', name: 'Failed' },
            ],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    const result = await ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam Ops' });

    expect(result.projectNumber).toBe('9');
    expect(result.projectId).toBe('PVT_NEW');
    expect(result.statusFieldId).toBe('FIELD_NEW');
    expect(execMock).toHaveBeenCalledTimes(4);
  });

  it('syncs pipeline child jobs onto the release root item and dedupes activities', async () => {
    const releaseJob = makeJob({
      id: 'release-1',
      kind: 'release',
      prompt: 'Release pipeline triggered.',
      finishedAt: null,
      exitCode: null,
    });
    const reviewJob = makeJob({
      id: 'review-1',
      kind: 'review',
      releaseId: 'release-1',
      finishedAt: 10,
      exitCode: 0,
      verdict: 'LGTM',
    });

    // The beforeEach mock for @/lib/shared/config returns enabled:false; this
    // test needs enabled:true. Reset the module cache so the override below
    // is the one that gets resolved on the next dynamic import (without the
    // reset, vitest sometimes serves the beforeEach factory under CI-level
    // worker pressure even when doMock is called second).
    vi.resetModules();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: 'octocat',
        github_board_sync_enabled: true,
        github_board_project_owner: 'octocat',
        github_board_project_title: 'TamTam',
        github_board_project_number: '7',
        github_board_project_id: 'PVT_1',
        github_board_status_field_id: 'FIELD_1',
        github_board_status_option_ids: {
          Queued: 'Q',
          Running: 'R',
          Review: 'REV',
          Fixing: 'F',
          'Ready to Push': 'P',
          Blocked: 'B',
          Done: 'D',
          Failed: 'X',
        },
      }),
    }));
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((jobId: string) => (jobId === 'release-1' ? releaseJob : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        return { exitCode: 0, stdout: 'feature/release\n', stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'ITEM_1' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(reviewJob, 'finished', { requireConfigured: true });
    await syncJobToProjectBoard(reviewJob, 'finished', { requireConfigured: true });

    const itemCreateCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-create');
    expect(itemCreateCalls).toHaveLength(1);
    expect(updateJobMock).toHaveBeenCalled();

    const storedMeta = JSON.parse(releaseJob.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_1');
    expect(storedMeta.branch).toBe('feature/release');
    expect(storedMeta.activities).toHaveLength(1);
    expect(storedMeta.activities[0].line).toContain('review passed (LGTM)');
  });

  it('engages a rate-limit cooldown after a 403 secondary-rate-limit response', async () => {
    vi.resetModules();
    const job = makeJob({ id: 'run-rl', kind: 'run', prompt: 'rate limit me' });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: 'octocat',
        github_board_sync_enabled: true,
        github_board_project_owner: 'octocat',
        github_board_project_title: 'TamTam',
        github_board_project_number: '7',
        github_board_project_id: 'PVT_1',
        github_board_status_field_id: 'FIELD_1',
        github_board_status_option_ids: {
          Queued: 'Q', Running: 'R', Review: 'REV', Fixing: 'F',
          'Ready to Push': 'P', Blocked: 'B', Done: 'D', Failed: 'X',
        },
      }),
    }));
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockReturnValue(null);

    let ghCalls = 0;
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      ghCalls++;
      return { exitCode: 1, stdout: '', stderr: 'HTTP 403: secondary rate limit exceeded' };
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await expect(syncJobToProjectBoard(job, 'manual', { requireConfigured: true })).rejects.toThrow(/rate limit/i);
    const ghCallsAfterFirst = ghCalls;
    await expect(syncJobToProjectBoard(job, 'manual', { requireConfigured: true })).rejects.toThrow(/cooldown/i);
    expect(ghCalls).toBe(ghCallsAfterFirst);
  });

  it('refuses to pass --prefixed strings as gh title/body args', async () => {
    vi.resetModules();
    const job = makeJob({
      id: 'run-inj',
      kind: 'run',
      prompt: 'normal prompt',
      contextMeta: JSON.stringify({ githubBoard: { title: '--format=json' } }),
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: 'octocat',
        github_board_sync_enabled: true,
        github_board_project_owner: 'octocat',
        github_board_project_title: 'TamTam',
        github_board_project_number: '7',
        github_board_project_id: 'PVT_1',
        github_board_status_field_id: 'FIELD_1',
        github_board_status_option_ids: {
          Queued: 'Q', Running: 'R', Review: 'REV', Fixing: 'F',
          'Ready to Push': 'P', Blocked: 'B', Done: 'D', Failed: 'X',
        },
      }),
    }));
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-inj' ? job : null));

    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      return { exitCode: 0, stdout: JSON.stringify({ id: 'X' }), stderr: '' };
    });

    const { queueJobBoardSync } = await import('@/lib/github/project-board');
    await queueJobBoardSync(job, 'manual');
    const itemCreateAttempted = execMock.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'project' && args[1] === 'item-create');
    expect(itemCreateAttempted).toBe(false);
  });

  it('reuses an existing board item discovered by marker lookup', async () => {
    vi.resetModules();
    const job = makeJob({ id: 'run-1', kind: 'run', prompt: 'Audit logs' });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        github_owner: 'octocat',
        github_board_sync_enabled: true,
        github_board_project_owner: 'octocat',
        github_board_project_title: 'TamTam',
        github_board_project_number: '7',
        github_board_project_id: 'PVT_1',
        github_board_status_field_id: 'FIELD_1',
        github_board_status_option_ids: {
          Queued: 'Q',
          Running: 'R',
          Review: 'REV',
          Fixing: 'F',
          'Ready to Push': 'P',
          Blocked: 'B',
          Done: 'D',
          Failed: 'X',
        },
      }),
    }));
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockReturnValue(null);

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        return { exitCode: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ items: [{ id: 'ITEM_EXISTING', body: 'TamTam Job ID: run-1' }] }),
          stderr: '',
        };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-create')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_EXISTING');
  });
});
