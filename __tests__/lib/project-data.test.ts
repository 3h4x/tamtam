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
      fix_prompt_addendum TEXT
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

  it('returns unpushed=0 when no upstream or clean', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no upstream' });
    const { fetchProjectData } = await import('@/lib/shared/project-data');
    const result = await fetchProjectData();
    const proj = result.projects['myproj']?.[0];
    expect(proj?.unpushed).toBe(0);
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
