import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      github TEXT,
      priority TEXT,
      custom_actions TEXT,
      test_command TEXT,
      tests_disabled INTEGER DEFAULT 0,
      review_disabled INTEGER DEFAULT 0,
      test_cron_enabled INTEGER DEFAULT 0,
      test_cron_schedule TEXT,
      auto_commit_enabled INTEGER DEFAULT 0,
      auto_push_enabled INTEGER DEFAULT 0,
      auto_pr_merge_enabled INTEGER DEFAULT 0,
      pr_workflow_enabled INTEGER DEFAULT 0,
      release_after_run INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL,
      review_prompt_addendum TEXT,
      fix_prompt_addendum TEXT,
      website TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('resolveProjectPath', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let resolveProjectPath: typeof import('@/lib/shared/project-data').resolveProjectPath;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/lib/shared/project-data');
    resolveProjectPath = mod.resolveProjectPath;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns null when no projects exist', () => {
    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns null when project is disabled', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: false })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns path for enabled project', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: true })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBe('/workspace/myproject');
  });

  it('returns null when project name does not match any enabled project', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'other-project', path: '/workspace/other', enabled: true })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns correct path when multiple enabled projects exist', () => {
    testDb.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/workspace/proj-a', enabled: true },
      { name: 'proj-b', path: '/workspace/proj-b', enabled: true },
      { name: 'proj-c', path: '/workspace/proj-c', enabled: true },
    ]).run();

    expect(resolveProjectPath('proj-a')).toBe('/workspace/proj-a');
    expect(resolveProjectPath('proj-b')).toBe('/workspace/proj-b');
    expect(resolveProjectPath('proj-c')).toBe('/workspace/proj-c');
    expect(resolveProjectPath('proj-d')).toBeNull();
  });

  it('ignores disabled projects among enabled ones', () => {
    testDb.db.insert(schema.projects).values([
      { name: 'enabled-proj', path: '/workspace/enabled', enabled: true },
      { name: 'disabled-proj', path: '/workspace/disabled', enabled: false },
    ]).run();

    expect(resolveProjectPath('enabled-proj')).toBe('/workspace/enabled');
    expect(resolveProjectPath('disabled-proj')).toBeNull();
  });
});

describe('fetchProjectData — unpushed field', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    testDb.db.insert(schema.projects).values({
      name: 'myproj',
      path: '/workspace/myproj',
      enabled: true,
    }).run();

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      gitChanges: vi.fn().mockResolvedValue(0),
      isReviewed: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/scheduling/launchagent', () => ({
      launchctlInfo: vi.fn().mockResolvedValue({ loaded: false, pid: null, plistMinute: null, wrapperPhase: null, wrapperCycle: null }),
      plistPath: vi.fn().mockReturnValue('/tmp/plist'),
      pausedPlistPath: vi.fn().mockReturnValue('/tmp/plist.paused'),
    }));
    vi.doMock('@/lib/shared/gh-status', () => ({
      ghStatusLookup: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('@/lib/jobs/run-history', () => ({
      lastRunLookup: vi.fn().mockReturnValue({}),
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
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns unpushed=0 when no upstream and no remote ref and no default ref', async () => {
    // Every git call fails — branch genuinely has nothing to compare against.
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no upstream' });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(0);
  });

  it('falls back to origin/<branch>..HEAD when @{u} has no upstream configured', async () => {
    // Simulates: branch has 2 local commits, remote ref `origin/feature-x`
    // exists but the local branch isn't tracking it (e.g. after a force-push
    // without --set-upstream). Without the fallback, unpushed silently reads
    // 0 and the Push button disables.
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
    // Brand-new local branch with no remote yet — should still surface a
    // count so the user can publish via the Push button (which uses
    // --set-upstream on first push).
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
    // Simulates: git commit succeeded (no changes), git push failed.
    // The rev-list ahead count should be 1 (the newly committed but unpushed change).
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
    // Ensure changes is 0 (clean working tree) — this is the exact scenario where
    // the Release button was wrongly disabled: no staged changes + unpushed commits.
    expect(proj?.changes).toBe(0);
  });
});

describe('fetchProjectData — project selection and metadata', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let execMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let launchctlInfoMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();

    testDb.db.insert(schema.projects).values([
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
    ]).run();

    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    existsSyncMock = vi.fn().mockReturnValue(false);
    launchctlInfoMock = vi.fn().mockResolvedValue({ loaded: false, pid: null, plistMinute: null, wrapperPhase: null, wrapperCycle: null });

    vi.doMock('fs', () => ({ existsSync: existsSyncMock }));
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/git/git-utils', () => ({
      gitChanges: vi.fn().mockResolvedValue(0),
      isReviewed: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/scheduling/launchagent', () => ({
      launchctlInfo: launchctlInfoMock,
      plistPath: vi.fn().mockImplementation((schedId: string) => `/tmp/${schedId}.plist`),
      pausedPlistPath: vi.fn().mockImplementation((schedId: string) => `/tmp/${schedId}.plist.paused`),
    }));
    vi.doMock('@/lib/shared/gh-status', () => ({
      ghStatusLookup: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('@/lib/jobs/run-history', () => ({
      lastRunLookup: vi.fn().mockReturnValue({}),
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
    testDb.sqlite.prepare('UPDATE projects SET github = ? WHERE name = ?').run('acme/configured-repo', 'enabled-proj');

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

  it('reports paused launchctl state when the paused plist exists', async () => {
    existsSyncMock.mockImplementation((path: string) => path.endsWith('.plist.paused'));

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.launchctl).toBe('paused');
  });

  it('reports installed launchctl state when only the plist exists', async () => {
    existsSyncMock.mockImplementation((path: string) => path.endsWith('.plist'));

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.launchctl).toBe('installed');
  });

  it('reports running launchctl state when daemon is loaded with a pid', async () => {
    launchctlInfoMock.mockResolvedValue({ loaded: true, pid: 12345, plistMinute: null, wrapperPhase: null, wrapperCycle: null });

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.launchctl).toBe('running');
  });

  it('reports loaded launchctl state when daemon is loaded but has no pid', async () => {
    launchctlInfoMock.mockResolvedValue({ loaded: true, pid: null, plistMinute: null, wrapperPhase: null, wrapperCycle: null });

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.launchctl).toBe('loaded');
  });

  it('reports missing launchctl state when daemon is not loaded and no plist files exist', async () => {
    existsSyncMock.mockReturnValue(false);

    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();

    expect(result.projects['enabled-proj']?.[0]?.launchctl).toBe('missing');
  });
});

describe('clearProjectDataCache', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clearProjectDataCache: typeof import('@/lib/shared/project-data').clearProjectDataCache;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

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
