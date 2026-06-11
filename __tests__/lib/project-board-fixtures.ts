import { beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

export function makeJob(overrides: Partial<JobData> = {}): JobData {
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

export const DISABLED_SETTINGS = {
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

export const ENABLED_SETTINGS = {
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

export function setupProjectBoardTest() {
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
  // factory Vitest resolves.
  let mockGetSettings: () => object = () => ({ ...DISABLED_SETTINGS });

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
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => mockGetSettings(),
      reloadConfig: reloadConfigMock,
    }));
  });

  return {
    execMock,
    updateJobMock,
    getJobMock,
    listJobsMock,
    resolveProjectPathMock,
    dbRunMock,
    dbExecuteMock,
    dbOnConflictMock,
    dbValuesMock,
    dbInsertMock,
    reloadConfigMock,
    setMockGetSettings(next: () => object) {
      mockGetSettings = next;
    },
  };
}
