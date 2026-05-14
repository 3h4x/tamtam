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

const DISABLED_SETTINGS = {
  github_owner: '',
  github_board_sync_enabled: false,
  github_board_project_owner: '',
  github_board_project_title: 'TamTam',
  github_board_project_number: '',
  github_board_project_url: '',
  github_board_project_id: '',
  github_board_status_field_id: '',
  github_board_status_option_ids: {},
  github_board_custom_field_ids: {},
};

const ENABLED_SETTINGS = {
  github_owner: 'octocat',
  github_board_sync_enabled: true,
  github_board_project_owner: 'octocat',
  github_board_project_title: 'TamTam',
  github_board_project_number: '7',
  github_board_project_url: 'https://github.com/users/octocat/projects/7',
  github_board_project_id: 'PVT_1',
  github_board_status_field_id: 'FIELD_1',
  github_board_status_option_ids: {
    'Todo': 'Q',
    'In Progress': 'R',
    'Review': 'REV',
    'Fixing': 'F',
    'Blocked': 'B',
    'Done': 'D',
  },
  github_board_custom_field_ids: {
    project: 'F_PROJECT',
    agent: 'F_AGENT',
    kind: 'F_KIND',
    branch: 'F_BRANCH',
  },
};

describe('project board integration', () => {
  const execMock = vi.fn();
  const updateJobMock = vi.fn();
  const getJobMock = vi.fn();
  const listJobsMock = vi.fn(() => [] as unknown[]);
  const resolveProjectPathMock = vi.fn();
  const dbRunMock = vi.fn();
  const dbExecuteMock = vi.fn(() => Promise.resolve());
  const dbOnConflictMock = vi.fn(() => ({ run: dbRunMock, execute: dbExecuteMock }));
  const dbValuesMock = vi.fn(() => ({ onConflictDoUpdate: dbOnConflictMock }));
  const dbInsertMock = vi.fn(() => ({ values: dbValuesMock }));
  const reloadConfigMock = vi.fn();

  // Mutable settings pointer: all vi.doMock factories for @/lib/shared/config
  // delegate here, so per-test overrides work regardless of which stacked
  // factory Vitest resolves — avoiding the "beforeEach factory wins" flake.
  let mockGetSettings: () => object;

  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    updateJobMock.mockReset();
    getJobMock.mockReset();
    listJobsMock.mockReset();
    listJobsMock.mockReturnValue([]);
    resolveProjectPathMock.mockReset();
    dbRunMock.mockReset();
    dbExecuteMock.mockReset();
    dbExecuteMock.mockImplementation(() => Promise.resolve());
    dbOnConflictMock.mockClear();
    dbValuesMock.mockClear();
    dbInsertMock.mockClear();
    reloadConfigMock.mockReset();
    mockGetSettings = () => ({ ...DISABLED_SETTINGS });

    vi.doMock('@/lib/shared/shell', () => ({
      exec: execMock,
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: getJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: { insert: dbInsertMock },
      schema: { settings: { key: 'key' } },
    }));
    // Factory always delegates to mockGetSettings() so that any stacked
    // registration from a previous beforeEach still returns the current
    // per-test settings without needing to override the factory itself.
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => mockGetSettings(),
      reloadConfig: reloadConfigMock,
    }));
  });

  it('reuses an existing GitHub project and built-in Status field when all options are already present', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [
              {
                id: 'FIELD_1',
                name: 'Status',
                options: [
                  { id: 'Q', name: 'Todo' },
                  { id: 'R', name: 'In Progress' },
                  { id: 'REV', name: 'Review' },
                  { id: 'F', name: 'Fixing' },
                  { id: 'B', name: 'Blocked' },
                  { id: 'D', name: 'Done' },
                ],
              },
              { id: 'F_PROJECT', name: 'Project' },
              { id: 'F_AGENT', name: 'Agent' },
              { id: 'F_KIND', name: 'Run kind' },
              { id: 'F_BRANCH', name: 'Branch' },
            ],
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
      projectUrl: 'https://github.com/users/octocat/projects/7',
      projectId: 'PVT_1',
      statusFieldId: 'FIELD_1',
      optionIds: {
        'Todo': 'Q',
        'In Progress': 'R',
        'Review': 'REV',
        'Fixing': 'F',
        'Blocked': 'B',
        'Done': 'D',
      },
      customFieldIds: {
        project: 'F_PROJECT',
        agent: 'F_AGENT',
        kind: 'F_KIND',
        branch: 'F_BRANCH',
      },
    });
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('creates the project and adds missing options to the built-in Status field via graphql', async () => {
    let fieldListCall = 0;
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'PVT_NEW', number: 9, title: 'TamTam Ops' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        fieldListCall++;
        if (fieldListCall === 1) {
          // Newly created GitHub project ships with default Todo / In Progress / Done.
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fields: [{
                id: 'FIELD_NEW',
                name: 'Status',
                options: [
                  { id: 'OT', name: 'Todo' },
                  { id: 'OP', name: 'In Progress' },
                  { id: 'OD', name: 'Done' },
                ],
              }],
            }),
            stderr: '',
          };
        }
        // After our graphql update, all 6 options are present.
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              id: 'FIELD_NEW',
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
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { exitCode: 0, stdout: JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'FIELD_NEW' } } } }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-create') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx >= 0 ? args[nameIdx + 1] : '';
        const id = `F_${name.replace(/\s+/g, '_').toUpperCase()}`;
        return { exitCode: 0, stdout: JSON.stringify({ id, name }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    const result = await ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam Ops' });

    expect(result.projectNumber).toBe('9');
    expect(result.projectId).toBe('PVT_NEW');
    expect(result.statusFieldId).toBe('FIELD_NEW');
    expect(result.projectUrl).toBe('https://github.com/users/octocat/projects/9');
    expect(result.optionIds).toEqual({
      'Todo': 'OT',
      'In Progress': 'OP',
      'Review': 'NREV',
      'Fixing': 'NFIX',
      'Blocked': 'NBLK',
      'Done': 'OD',
    });
    expect(result.customFieldIds).toEqual({
      project: 'F_PROJECT',
      agent: 'F_AGENT',
      kind: 'F_RUN_KIND',
      branch: 'F_BRANCH',
    });
    // list, create, field-list, graphql, field-list (re-read), 4× field-create
    expect(execMock).toHaveBeenCalledTimes(9);
    const graphqlCall = execMock.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === 'api' && args[1] === 'graphql');
    expect(graphqlCall).toBeDefined();
    const queryArg = String(graphqlCall![1][3] ?? '');
    expect(queryArg).toContain('updateProjectV2Field');
    expect(queryArg).toContain('"Review"');
    expect(queryArg).toContain('"Fixing"');
    expect(queryArg).toContain('"Blocked"');
  });

  it('fails clearly when gh project create returns an unparseable payload', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'create') {
        return { exitCode: 0, stdout: JSON.stringify({ project: null }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Failed to parse gh project create response',
    );
  });

  it('fails clearly when the built-in Status field is missing from the board', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{ id: 'F_PROJECT', name: 'Project' }],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Built-in Status field not found on project',
    );
  });

  it('fails clearly when the built-in Status field has no id and needs option upgrades', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              name: 'Status',
              options: [
                { id: 'Q', name: 'Todo' },
                { id: 'R', name: 'In Progress' },
                { id: 'D', name: 'Done' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Built-in Status field has no ID',
    );
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

    // Update the shared settings pointer — the beforeEach factory delegates
    // to mockGetSettings(), so this applies regardless of which stacked
    // factory Vitest picks for @/lib/shared/config.
    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
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
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_ITEM_1' }), stderr: '' };
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
    expect(storedMeta.itemId).toBe('DI_ITEM_1');
    expect(storedMeta.branch).toBe('feature/release');
    expect(storedMeta.activities).toHaveLength(1);
    expect(storedMeta.activities[0].line).toContain('review passed (LGTM)');
  });

  it('engages a rate-limit cooldown after a 403 secondary-rate-limit response', async () => {
    const job = makeJob({ id: 'run-rl', kind: 'run', prompt: 'rate limit me' });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
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

  it('throws a clear error when manual sync is required but board sync is disabled', async () => {
    const job = makeJob({ id: 'disabled-sync-job', kind: 'run' });

    mockGetSettings = () => ({ ...DISABLED_SETTINGS });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await expect(syncJobToProjectBoard(job, 'manual', { requireConfigured: true })).rejects.toThrow(
      'GitHub board sync is disabled.',
    );
  });

  it('throws a clear error when board sync is enabled without a GitHub owner', async () => {
    const job = makeJob({ id: 'missing-owner-job', kind: 'run' });

    mockGetSettings = () => ({
      ...ENABLED_SETTINGS,
      github_owner: '',
      github_board_project_owner: '',
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await expect(syncJobToProjectBoard(job, 'manual', { requireConfigured: true })).rejects.toThrow(
      'GitHub board sync requires a GitHub owner.',
    );
  });

  it('no-ops when board sync is unavailable and configuration is not required', async () => {
    const job = makeJob({ id: 'optional-sync-job', kind: 'run' });

    mockGetSettings = () => ({ ...DISABLED_SETTINGS });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await expect(syncJobToProjectBoard(job, 'manual')).resolves.toBeUndefined();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('refuses to pass --prefixed strings as gh title/body args', async () => {
    const job = makeJob({
      id: 'run-inj',
      kind: 'run',
      prompt: 'normal prompt',
      contextMeta: JSON.stringify({ githubBoard: { title: '--format=json' } }),
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
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

  it('logs a concise warning instead of a stack trace for rate-limit errors', async () => {
    const job = makeJob({ id: 'rate-limit-job', kind: 'run' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { logBoardSyncError } = await import('@/lib/github/project-board');
    logBoardSyncError(job.id, 'manual', new Error('GitHub board sync skipped: rate-limit cooldown active'));

    expect(warnSpy).toHaveBeenCalledWith(
      `[github-board] sync skipped for ${job.id} (manual): GitHub board sync skipped: rate-limit cooldown active`,
    );
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('keeps generic HTTP 403 board sync failures on console.error', async () => {
    const job = makeJob({ id: 'forbidden-job', kind: 'run' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('HTTP 403: Resource not accessible by integration');

    const { logBoardSyncError } = await import('@/lib/github/project-board');
    logBoardSyncError(job.id, 'manual', error);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      `[github-board] sync failed for ${job.id} (manual)`,
      error,
    );

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reuses an existing board item discovered by marker lookup', async () => {
    const job = makeJob({ id: 'run-1', kind: 'run', prompt: 'Audit logs' });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
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

  it('trusts a stored PVTI item id and skips board rediscovery', async () => {
    const job = makeJob({
      id: 'run-existing-pvti',
      kind: 'run',
      prompt: 'Reuse existing card',
      contextMeta: JSON.stringify({ githubBoard: { itemId: 'PVTI_STORED' } }),
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-existing-pvti' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        return { exitCode: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-list')).toBe(false);
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-create')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('PVTI_STORED');
  });

  it('writes Project / Agent / Run kind / Branch custom fields and skips re-writes on the next sync', async () => {
    const job = makeJob({
      id: 'agent-cf-1',
      kind: 'agent:ui-components',
      project: 'borged',
      prompt: 'standardise components',
      finishedAt: 100,
      exitCode: 0,
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'agent-cf-1' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_NEW' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const fieldWrites = (predicate: (call: string[]) => boolean) =>
      calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-edit' && predicate(entry));

    const projectWrites = fieldWrites((c) => c.includes('--field-id') && c.includes('F_PROJECT') && c.includes('--text') && c.includes('borged'));
    const agentWrites = fieldWrites((c) => c.includes('F_AGENT') && c.includes('ui-components'));
    const kindWrites = fieldWrites((c) => c.includes('F_KIND') && c.includes('agent:ui-components'));
    const branchWrites = fieldWrites((c) => c.includes('F_BRANCH') && c.includes('main'));
    expect(projectWrites).toHaveLength(1);
    expect(agentWrites).toHaveLength(1);
    expect(kindWrites).toHaveLength(1);
    expect(branchWrites).toHaveLength(1);

    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.customFields).toEqual({
      project: 'borged',
      agent: 'ui-components',
      kind: 'agent:ui-components',
      branch: 'main',
    });
    expect(storedMeta.title).toBe('ui-components agent · borged');

    // Second sync — values unchanged, no custom field writes should fire.
    const callsBefore = calls.length;
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });
    const newCalls = calls.slice(callsBefore);
    const newFieldWrites = newCalls.filter((entry) =>
      entry[1] === 'project' && entry[2] === 'item-edit' &&
      (entry.includes('F_PROJECT') || entry.includes('F_AGENT') || entry.includes('F_KIND') || entry.includes('F_BRANCH')),
    );
    expect(newFieldWrites).toHaveLength(0);
  });

  it('clears a stale Agent custom field when syncing a non-agent run', async () => {
    const job = makeJob({
      id: 'run-clear-agent',
      kind: 'run',
      prompt: 'plain run',
      contextMeta: JSON.stringify({
        githubBoard: {
          itemId: 'DI_EXISTING',
          customFields: {
            project: 'borged',
            agent: 'ui-components',
            kind: 'agent:ui-components',
            branch: 'main',
          },
        },
      }),
      finishedAt: 100,
      exitCode: 0,
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-clear-agent' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const clearCall = calls.find((entry) =>
      entry[1] === 'project' &&
      entry[2] === 'item-edit' &&
      entry.includes('F_AGENT') &&
      entry.includes('--clear'),
    );
    expect(clearCall).toBeDefined();

    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.customFields).toEqual({
      project: 'proj',
      agent: '',
      kind: 'run',
      branch: 'main',
    });
  });

  it('auto-upgrades legacy board settings during sync and persists the new IDs', async () => {
    const job = makeJob({
      id: 'legacy-sync-1',
      kind: 'run',
      prompt: 'upgrade legacy board settings',
    });
    mockGetSettings = () => ({
      ...ENABLED_SETTINGS,
      github_board_project_url: '',
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
    });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'legacy-sync-1' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }),
          stderr: '',
        };
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

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
    expect(dbInsertMock).toHaveBeenCalledTimes(8);
    const persisted = (dbValuesMock.mock.calls as unknown as Array<[unknown]>)
      .map(([value]) => value as { key: string; value: string });
    expect(persisted).toEqual(expect.arrayContaining([
      { key: 'github_board_project_url', value: 'https://github.com/users/octocat/projects/7' },
      { key: 'github_board_status_option_ids', value: JSON.stringify({
        'Todo': 'OT',
        'In Progress': 'OP',
        'Review': 'NREV',
        'Fixing': 'NFIX',
        'Blocked': 'NBLK',
        'Done': 'OD',
      }) },
      { key: 'github_board_custom_field_ids', value: JSON.stringify({
        project: 'F_PROJECT',
        agent: 'F_AGENT',
        kind: 'F_RUN_KIND',
        branch: 'F_BRANCH',
      }) },
    ]));
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'field-create')).toBe(true);
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-edit' && entry.includes('F_PROJECT'))).toBe(true);
  });

  it('reuses an issue-linked board item by content URL match instead of creating a draft', async () => {
    const job = makeJob({
      id: 'run-issue-1',
      kind: 'run',
      prompt: 'Work on issue 42',
      ghIssueNumber: 42,
      ghIssueRepo: '3h4x/tamtam',
      ghIssueTitle: 'Investigate the thing',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-issue-1' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [{
              id: 'ITEM_ISSUE_42',
              content: { type: 'Issue', url: 'https://github.com/3h4x/tamtam/issues/42', title: 'Investigate the thing' },
            }],
          }),
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
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-add')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_ISSUE_42');
    // Content-linked items must not get title/body edits.
    const titleBodyEdits = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-edit' && entry.includes('--title'));
    expect(titleBodyEdits).toHaveLength(0);
    // Status field update is still applied.
    const statusEdits = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-edit' && entry.includes('--single-select-option-id'));
    expect(statusEdits).toHaveLength(1);
  });

  it('matches issue-linked board items by exact content URL, not numeric prefix', async () => {
    const job = makeJob({
      id: 'run-issue-4',
      kind: 'run',
      prompt: 'Work on issue 4',
      ghIssueNumber: 4,
      ghIssueRepo: '3h4x/tamtam',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-issue-4' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                id: 'ITEM_ISSUE_42',
                content: { type: 'Issue', url: 'https://github.com/3h4x/tamtam/issues/42' },
              },
              {
                id: 'ITEM_ISSUE_4',
                content: { type: 'Issue', url: 'https://github.com/3h4x/tamtam/issues/4' },
              },
            ],
          }),
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
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-add')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_ISSUE_4');
  });

  it('reuses PR-linked board items by exact content URL match', async () => {
    const job = makeJob({
      id: 'run-pr-7',
      kind: 'run',
      prompt: 'Review PR 7',
      ghIssueNumber: 7,
      ghIssueRepo: '3h4x/tamtam',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-pr-7' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                id: 'ITEM_PR_70',
                content: { type: 'PullRequest', url: 'https://github.com/3h4x/tamtam/pull/70' },
              },
              {
                id: 'ITEM_PR_7',
                content: { type: 'PullRequest', url: 'https://github.com/3h4x/tamtam/pull/7' },
              },
            ],
          }),
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
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-add')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_PR_7');
  });

  it('adds an issue/PR to the board via item-add when no matching item exists', async () => {
    const job = makeJob({
      id: 'run-issue-99',
      kind: 'run',
      prompt: 'Fix issue 99',
      ghIssueNumber: 99,
      ghIssueRepo: '3h4x/tamtam',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-issue-99' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-add') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'ITEM_ADDED_99' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const addCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-add');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toContain('https://github.com/3h4x/tamtam/issues/99');
    expect(calls.some((entry) => entry[1] === 'project' && entry[2] === 'item-create')).toBe(false);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_ADDED_99');
  });

  it('falls back to the pull URL when adding the issues URL fails', async () => {
    const job = makeJob({
      id: 'run-pr-fallback',
      kind: 'run',
      prompt: 'Review PR 7',
      ghIssueNumber: 7,
      ghIssueRepo: '3h4x/tamtam',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-pr-fallback' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-add' && args.some((arg) => arg.endsWith('/issues/7'))) {
        return { exitCode: 1, stdout: '', stderr: 'resource is a pull request' };
      }
      if (args[0] === 'project' && args[1] === 'item-add' && args.some((arg) => arg.endsWith('/pull/7'))) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'ITEM_PR_FALLBACK' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const addCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-add');
    expect(addCalls).toHaveLength(2);
    expect(addCalls[0]).toContain('https://github.com/3h4x/tamtam/issues/7');
    expect(addCalls[1]).toContain('https://github.com/3h4x/tamtam/pull/7');
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('ITEM_PR_FALLBACK');
  });

  it('falls back to draft creation when item-add succeeds with an unparseable payload', async () => {
    const job = makeJob({
      id: 'run-issue-unparseable-add',
      kind: 'run',
      prompt: 'Fix issue 123',
      ghIssueNumber: 123,
      ghIssueRepo: '3h4x/tamtam',
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-issue-unparseable-add' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-add') {
        return { exitCode: 0, stdout: JSON.stringify({ item: null }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_FROM_FALLBACK' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const addCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-add');
    expect(addCalls).toHaveLength(1);
    const createCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-create');
    expect(createCalls).toHaveLength(1);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('DI_FROM_FALLBACK');
  });

  it('recovers from a deleted board card by clearing the stored itemId and re-creating', async () => {
    const job = makeJob({
      id: 'run-deleted-card',
      kind: 'run',
      prompt: 'card got deleted',
      contextMeta: JSON.stringify({ githubBoard: { itemId: 'PVTI_GONE' } }),
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-deleted-card' ? job : null));

    const calls: string[][] = [];
    let updateAttempt = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        // After we clear the stale id, rediscovery sees an empty board.
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        // First attempt (against PVTI_GONE) fails with resource-not-found;
        // retry against the freshly created draft succeeds.
        const isStaleTarget = args.includes('PVTI_GONE');
        if (isStaleTarget && updateAttempt === 0) {
          updateAttempt++;
          return { exitCode: 1, stdout: '', stderr: 'resource not found, please check the URL' };
        }
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_REPLACEMENT' }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const itemCreateCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-create');
    expect(itemCreateCalls).toHaveLength(1);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('DI_REPLACEMENT');
  });

  it('retries with a recreated draft item when the title/body edit hits a stale DI_ id', async () => {
    const job = makeJob({
      id: 'run-stale-draft',
      kind: 'run',
      prompt: 'draft card got deleted',
      contextMeta: JSON.stringify({ githubBoard: { itemId: 'DI_STALE' } }),
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-stale-draft' ? job : null));

    const calls: string[][] = [];
    let staleBodyEditAttempted = false;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        const targetsStaleDraft = args.includes('DI_STALE');
        const editsBody = args.includes('--title') && args.includes('--body');
        if (targetsStaleDraft && editsBody && !staleBodyEditAttempted) {
          staleBodyEditAttempted = true;
          return { exitCode: 1, stdout: '', stderr: 'item not found' };
        }
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_RECREATED' }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const itemCreateCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-create');
    expect(itemCreateCalls).toHaveLength(1);
    const staleBodyEditCalls = calls.filter((entry) =>
      entry[1] === 'project' &&
      entry[2] === 'item-edit' &&
      entry.includes('DI_STALE') &&
      entry.includes('--title') &&
      entry.includes('--body'),
    );
    expect(staleBodyEditCalls).toHaveLength(1);
    const recreatedBodyEditCalls = calls.filter((entry) =>
      entry[1] === 'project' &&
      entry[2] === 'item-edit' &&
      entry.includes('DI_RECREATED') &&
      entry.includes('--title') &&
      entry.includes('--body'),
    );
    expect(recreatedBodyEditCalls).toHaveLength(1);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('DI_RECREATED');
  });

  it('clears invalid item IDs (not starting with DI_) and creates new ones', async () => {
    const job = makeJob({
      id: 'run-invalid-id',
      kind: 'run',
      prompt: 'Invalid ID test',
      contextMeta: JSON.stringify({ githubBoard: { itemId: 'INVALID_ITEM_ID' } }),
    });

    mockGetSettings = () => ({ ...ENABLED_SETTINGS });
    resolveProjectPathMock.mockReturnValue('/tmp/repo');
    getJobMock.mockImplementation((id: string) => (id === 'run-invalid-id' ? job : null));

    const calls: string[][] = [];
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        return { exitCode: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-list') {
        return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'DI_ITEM_VALID' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { syncJobToProjectBoard } = await import('@/lib/github/project-board');
    await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });

    const itemCreateCalls = calls.filter((entry) => entry[1] === 'project' && entry[2] === 'item-create');
    expect(itemCreateCalls).toHaveLength(1);
    const storedMeta = JSON.parse(job.contextMeta ?? '{}').githubBoard;
    expect(storedMeta.itemId).toBe('DI_ITEM_VALID');
  });
});

describe('isBoardSyncRateLimitError', () => {
  beforeEach(() => vi.resetModules());

  it('returns true for an error whose name is RateLimitError', async () => {
    const { isBoardSyncRateLimitError } = await import('@/lib/github/project-board');
    const err = Object.assign(new Error('GitHub board sync skipped: rate-limit cooldown active'), { name: 'RateLimitError' });
    expect(isBoardSyncRateLimitError(err)).toBe(true);
  });

  it('returns true for an Error whose message matches a rate-limit pattern', async () => {
    const { isBoardSyncRateLimitError } = await import('@/lib/github/project-board');
    expect(isBoardSyncRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(isBoardSyncRateLimitError(new Error('secondary rate limit triggered'))).toBe(true);
    expect(isBoardSyncRateLimitError(new Error('GitHub abuse detection triggered'))).toBe(true);
  });

  it('returns true for a non-Error value whose string representation matches', async () => {
    const { isBoardSyncRateLimitError } = await import('@/lib/github/project-board');
    expect(isBoardSyncRateLimitError('rate-limit cooldown active')).toBe(true);
  });

  it('returns false for a generic error that does not match any rate-limit pattern', async () => {
    const { isBoardSyncRateLimitError } = await import('@/lib/github/project-board');
    expect(isBoardSyncRateLimitError(new Error('HTTP 403: Resource not accessible by integration'))).toBe(false);
    expect(isBoardSyncRateLimitError(new Error('network timeout'))).toBe(false);
    expect(isBoardSyncRateLimitError(null)).toBe(false);
  });
});
