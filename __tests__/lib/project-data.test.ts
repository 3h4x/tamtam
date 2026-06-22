import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// Shared PGlite handle for all describe blocks — was previously booted per
// test (5 boots × ~500ms ≈ 2.5s overhead per test on top of mock setup).
let sharedHandle: TestDbHandle;

async function truncateTables(): Promise<void> {
  await sharedHandle.db.execute(sql.raw('TRUNCATE projects, settings'));
}

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      pr_workflow_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

/**
 * `listEnabledProjects` reads from a sync TTL cache populated by an async DB
 * fetch. `refreshProjectsCacheSync` is a test-only API that awaits the refresh
 * directly — much faster (and correct) when the DB may have zero enabled rows,
 * which would otherwise make a polling helper wait its full timeout.
 */
async function primeEnabledProjectsCache(): Promise<void> {
  const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
  await refreshProjectsCacheSync();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyDdl(sharedHandle);
});

afterAll(async () => {
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

describe('resolveProjectPath', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let resolveProjectPath: typeof import('@/lib/shared/project-data').resolveProjectPath;

  beforeEach(async () => {
    await truncateTables();
    vi.resetModules();

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));

    const mod = await import('@/lib/shared/project-data');
    resolveProjectPath = mod.resolveProjectPath;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns null when no projects exist', async () => {
    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns null when project is disabled', async () => {
    await handle.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: false });
    await primeEnabledProjectsCache();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns path for enabled project', async () => {
    await handle.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: true });
    await primeEnabledProjectsCache();

    const result = resolveProjectPath('myproject');
    expect(result).toBe('/workspace/myproject');
  });

  it('returns null when project name does not match any enabled project', async () => {
    await handle.db
      .insert(schema.projects)
      .values({ name: 'other-project', path: '/workspace/other', enabled: true });
    await primeEnabledProjectsCache();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns correct path when multiple enabled projects exist', async () => {
    await handle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/workspace/proj-a', enabled: true },
      { name: 'proj-b', path: '/workspace/proj-b', enabled: true },
      { name: 'proj-c', path: '/workspace/proj-c', enabled: true },
    ]);
    await primeEnabledProjectsCache();

    expect(resolveProjectPath('proj-a')).toBe('/workspace/proj-a');
    expect(resolveProjectPath('proj-b')).toBe('/workspace/proj-b');
    expect(resolveProjectPath('proj-c')).toBe('/workspace/proj-c');
    expect(resolveProjectPath('proj-d')).toBeNull();
  });

  it('ignores disabled projects among enabled ones', async () => {
    await handle.db.insert(schema.projects).values([
      { name: 'enabled-proj', path: '/workspace/enabled', enabled: true },
      { name: 'disabled-proj', path: '/workspace/disabled', enabled: false },
    ]);
    await primeEnabledProjectsCache();

    expect(resolveProjectPath('enabled-proj')).toBe('/workspace/enabled');
    expect(resolveProjectPath('disabled-proj')).toBeNull();
  });
});

describe('fetchProjectData — unpushed field', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateTables();
    vi.resetModules();

    await sharedHandle.db.insert(schema.projects).values({
      name: 'myproj',
      path: '/workspace/myproj',
      enabled: true,
    });

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      gitChanges: vi.fn().mockResolvedValue(0),
      isReviewed: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/shared/gh-status', () => ({
      ghStatusLookup: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ logDir: '/tmp/logs', claudeBin: 'claude', projects: {}, freqMin: 60 }),
      getPriorityMultipliers: vi.fn().mockReturnValue({}),
      effectiveFreqMin: vi.fn().mockReturnValue(60),
      computeSchedule: vi.fn().mockReturnValue({ minute: 0, cycleHours: 1, hourPhase: 0 }),
      parseCronTime: vi.fn(),
      cronFiresStr: vi.fn().mockReturnValue('every 1h'),
      PRIORITY_ORDER: ['critical', 'high', 'medium', 'low', 'none'],
    }));
    vi.doMock('@/lib/scheduling/fire-times', () => ({
      fireTimesStr: vi.fn().mockReturnValue('every 1h'),
    }));
    await primeEnabledProjectsCache();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns unpushed=0 when no upstream and no remote ref and no default ref', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no upstream' });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(0);
  });

  it('falls back to origin/<branch>..HEAD when @{u} has no upstream configured', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: no upstream configured for branch' });
      }
      if (args.includes('branch') && args.includes('--show-current')) {
        return Promise.resolve({ exitCode: 0, stdout: 'feature-x\n', stderr: '' });
      }
      if (args.includes('rev-parse') && args.includes('--verify') && args.includes('refs/remotes/origin/feature-x')) {
        return Promise.resolve({ exitCode: 0, stdout: 'abc1234\n', stderr: '' });
      }
      if (args.includes('rev-list') && args.includes('refs/remotes/origin/feature-x..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '2\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(2);
  });

  it('falls back to <defaultRef>..HEAD when no upstream and no remote ref for the branch', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: no upstream' });
      }
      if (args.includes('branch') && args.includes('--show-current')) {
        return Promise.resolve({ exitCode: 0, stdout: 'brand-new-branch\n', stderr: '' });
      }
      if (args.includes('rev-parse') && args.includes('refs/remotes/origin/brand-new-branch')) {
        return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'unknown ref' });
      }
      if (args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: 'origin/main\n', stderr: '' });
      }
      if (args.includes('rev-list') && args.includes('origin/main..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '5\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(5);
  });

  it('falls back to <defaultRef>..HEAD when origin/<branch> exists but ahead count fails', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: no upstream configured for branch' });
      }
      if (args.includes('branch') && args.includes('--show-current')) {
        return Promise.resolve({ exitCode: 0, stdout: 'feature-x\n', stderr: '' });
      }
      if (args.includes('rev-parse') && args.includes('--verify') && args.includes('refs/remotes/origin/feature-x')) {
        return Promise.resolve({ exitCode: 0, stdout: 'abc1234\n', stderr: '' });
      }
      if (args.includes('rev-list') && args.includes('refs/remotes/origin/feature-x..HEAD')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'ambiguous argument' });
      }
      if (args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: 'origin/main\n', stderr: '' });
      }
      if (args.includes('rev-list') && args.includes('origin/main..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '4\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(4);
  });

  it('returns unpushed count from git rev-list', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '3\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(3);
  });

  it('returns unpushed=1 after a failed push (commit succeeded but push failed)', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '1\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(1);
    expect(proj?.changes).toBe(0);
  });
});

describe('fetchProjectData — project selection and metadata', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateTables();
    vi.resetModules();

    await sharedHandle.db.insert(schema.projects).values([
      {
        name: 'enabled-proj',
        path: '/workspace/enabled',
        enabled: true,
      },
      {
        name: 'disabled-proj',
        path: '/workspace/disabled',
        enabled: false,
      },
    ]);

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      gitChanges: vi.fn().mockResolvedValue(0),
      isReviewed: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/shared/gh-status', () => ({
      ghStatusLookup: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ logDir: '/tmp/logs', claudeBin: 'claude', projects: {}, freqMin: 60 }),
      getPriorityMultipliers: vi.fn().mockReturnValue({}),
      effectiveFreqMin: vi.fn().mockReturnValue(60),
      computeSchedule: vi.fn().mockReturnValue({ minute: 15, cycleHours: 4, hourPhase: 1 }),
      parseCronTime: vi.fn(),
      cronFiresStr: vi.fn().mockReturnValue('every 4h'),
      PRIORITY_ORDER: ['critical', 'high', 'medium', 'low', 'none'],
    }));
    vi.doMock('@/lib/scheduling/fire-times', () => ({
      fireTimesStr: vi.fn().mockReturnValue('every 4h'),
    }));
    await primeEnabledProjectsCache();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns only enabled projects', async () => {
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(Object.keys(result.projects)).toEqual(['enabled-proj']);
    expect(result.projects['enabled-proj']).toHaveLength(1);
  });

  it('normalizes SSH GitHub remotes into https URLs', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' });
      }
      if (args.includes('remote') && args.includes('get-url') && args.includes('origin')) {
        return Promise.resolve({ exitCode: 0, stdout: 'git@github.com:acme/widgets.git\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.github).toBe('https://github.com/acme/widgets');
  });

  it('prefers the configured GitHub slug without shelling for the remote URL', async () => {
    await handle.db.execute(sql.raw(
      `UPDATE projects SET github = 'acme/configured-repo' WHERE name = 'enabled-proj'`,
    ));
    const { clearProjectsCache } = await import('@/lib/shared/enabled-projects');
    clearProjectsCache();
    await primeEnabledProjectsCache();

    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-list') && args.includes('@{u}..HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.github).toBe('https://github.com/acme/configured-repo');
    expect(execMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('remote') && args.includes('get-url'))).toBe(false);
  });

  it('reports paused=true when the project row is paused', async () => {
    await handle.db.execute(sql.raw(
      `UPDATE projects SET paused = true WHERE name = 'enabled-proj'`,
    ));
    const { clearProjectsCache } = await import('@/lib/shared/enabled-projects');
    clearProjectsCache();
    await primeEnabledProjectsCache();

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.paused).toBe(true);
  });

  it('reports paused=false when the project row is not paused', async () => {
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.paused).toBe(false);
  });

  it('does not let a refresh started before clearProjectDataCache repopulate the cache', async () => {
    const firstGitChanges = deferred<number | null>();
    let gitChangesCalls = 0;
    const gitChangesMock = vi.fn().mockImplementation(() => {
      gitChangesCalls += 1;
      if (gitChangesCalls === 1) return firstGitChanges.promise;
      return Promise.resolve(2);
    });
    vi.doMock('@/lib/git/git-utils', () => ({
      gitChanges: gitChangesMock,
      isReviewed: vi.fn().mockResolvedValue(null),
    }));

    const { fetchProjectData, clearProjectDataCache } = await import('@/lib/shared/project-data');
    const firstFetch = fetchProjectData();
    expect(gitChangesMock).toHaveBeenCalledTimes(1);

    clearProjectDataCache();
    firstGitChanges.resolve(1);
    await firstFetch;

    const second = await fetchProjectData();
    expect(second.projects['enabled-proj']?.[0]?.changes).toBe(2);
    expect(gitChangesMock).toHaveBeenCalledTimes(2);
  });
});

describe('clearProjectDataCache', () => {
  let clearProjectDataCache: typeof import('@/lib/shared/project-data').clearProjectDataCache;

  beforeEach(async () => {
    await truncateTables();
    vi.resetModules();

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));

    const mod = await import('@/lib/shared/project-data');
    clearProjectDataCache = mod.clearProjectDataCache;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('can be called without error', () => {
    expect(() => clearProjectDataCache()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    clearProjectDataCache();
    clearProjectDataCache();
    clearProjectDataCache();
  });
});
