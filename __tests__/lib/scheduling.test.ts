import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseFrequency,
  effectiveFreqMin,
  computeSchedule,
  parseCronTime,
  cronFiresStr,
  resolveTargets,
  writePriorityYaml,
  writeProjectFieldYaml,
  getProjectTestConfig,
} from '@/lib/scheduling/scheduling';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
      website TEXT,
      qa_url TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('parseFrequency', () => {
  it('parses minutes', () => {
    expect(parseFrequency('10m')).toBe(10);
    expect(parseFrequency('90m')).toBe(90);
  });
  it('parses hours', () => {
    expect(parseFrequency('2h')).toBe(120);
    expect(parseFrequency('1h')).toBe(60);
  });
  it('parses raw number', () => {
    expect(parseFrequency('30')).toBe(30);
  });
});

describe('effectiveFreqMin', () => {
  const multipliers = { critical: 1, high: 2, medium: 4, low: 8 };

  it('applies multiplier', () => {
    expect(effectiveFreqMin('critical', multipliers, 60)).toBe(60);
    expect(effectiveFreqMin('high', multipliers, 60)).toBe(120);
    expect(effectiveFreqMin('medium', multipliers, 60)).toBe(240);
    expect(effectiveFreqMin('low', multipliers, 60)).toBe(480);
  });

  it('uses default for unknown priority', () => {
    expect(effectiveFreqMin('unknown', multipliers, 60)).toBe(240);
  });
});

describe('computeSchedule', () => {
  it('computes minute and cycle', () => {
    const result = computeSchedule(0, 60, 120);
    expect(result.minute).toBe(0);
    expect(result.cycleHours).toBe(2);
    expect(result.hourPhase).toBe(0);
  });

  it('staggers by tier index', () => {
    const r1 = computeSchedule(1, 30, 120);
    expect(r1.minute).toBe(30);
    expect(r1.hourPhase).toBe(0);

    const r2 = computeSchedule(2, 30, 120);
    expect(r2.minute).toBe(0);
    expect(r2.hourPhase).toBe(1);
  });
});

describe('parseCronTime', () => {
  it('parses simple daily cron', () => {
    const r = parseCronTime('30 2 * * *');
    expect(r).toEqual({ minute: 30, step: 0, start: 2, weekday: null });
  });

  it('parses */N hour step', () => {
    const r = parseCronTime('0 */3 * * *');
    expect(r).toEqual({ minute: 0, step: 3, start: 0, weekday: null });
  });

  it('parses S/N hour step', () => {
    const r = parseCronTime('15 1/4 * * *');
    expect(r).toEqual({ minute: 15, step: 4, start: 1, weekday: null });
  });

  it('parses weekday cron', () => {
    const r = parseCronTime('0 3 * * 1');
    expect(r).toEqual({ minute: 0, step: 0, start: 3, weekday: 1 });
  });
});

describe('cronFiresStr', () => {
  it('shows daily schedule', () => {
    expect(cronFiresStr('30 2 * * *')).toBe('daily 02:30');
  });

  it('shows hourly schedule', () => {
    expect(cronFiresStr('0 */1 * * *')).toBe('every 1h :00');
  });

  it('shows step schedule', () => {
    expect(cronFiresStr('15 */3 * * *')).toBe('every 3h +0h :15');
  });

  it('shows weekday schedule', () => {
    expect(cronFiresStr('0 3 * * 1')).toBe('Mon 03:00');
  });

  it('shows Sunday schedule', () => {
    expect(cronFiresStr('30 10 * * 0')).toBe('Sun 10:30');
  });
});

describe('resolveTargets', () => {
  it('returns array with key if projectArg matches a key', () => {
    const projects = {
      'sched-1': { project: 'myproj', path: '/p', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null, test_command: null },
    };
    expect(resolveTargets('sched-1', projects)).toEqual(['sched-1']);
  });

  it('returns matching keys by project name', () => {
    const projects = {
      'a': { project: 'shared', path: '/a', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null, test_command: null },
      'b': { project: 'shared', path: '/b', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null, test_command: null },
      'c': { project: 'other', path: '/c', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null, test_command: null },
    };
    const result = resolveTargets('shared', projects);
    expect(result).toEqual(['a', 'b']);
  });

  it('returns null when no match found', () => {
    const projects = {
      'a': { project: 'myproj', path: '/a', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null, test_command: null },
    };
    expect(resolveTargets('nonexistent', projects)).toBeNull();
  });

  it('returns empty projects as null', () => {
    expect(resolveTargets('anything', {})).toBeNull();
  });
});

describe('writePriorityYaml', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        workspace_path: '/workspace',
        github_owner: '',
        claude_bin: '~/.local/bin/claude',
        log_dir: '~/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns false when project does not exist', async () => {
    const { writePriorityYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('nonexistent', null, 'high')).toBe(false);
  });

  it('updates priority for existing project', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writePriorityYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', null, 'high')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.priority).toBe('high');
  });

  it('clears priority when null is passed', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, priority: 'critical' }).run();
    const { writePriorityYaml: fn } = await import('@/lib/scheduling/scheduling');
    fn('proj1', null, null);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.priority).toBeNull();
  });
});

describe('writeProjectFieldYaml', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        workspace_path: '/workspace',
        github_owner: '',
        claude_bin: '~/.local/bin/claude',
        log_dir: '~/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns false when project does not exist', async () => {
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('nonexistent', 'github', 'owner/repo')).toBe(false);
  });

  it('updates github field', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'github', 'owner/proj1')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.github).toBe('owner/proj1');
  });

  it('updates priority field', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'priority', 'critical')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.priority).toBe('critical');
  });

  it('returns true for unknown field (no-op)', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'unknown_field', 'value')).toBe(true);
  });

  it('sets tests_disabled=true when value is "1"', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'tests_disabled', '1')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.testsDisabled).toBe(true);
  });

  it('clears tests_disabled when value is "0"', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'tests_disabled', '0')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.testsDisabled).toBeFalsy();
  });

  it('sets review_disabled=true when value is "1"', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'review_disabled', '1')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.reviewDisabled).toBe(true);
  });

  it('clears review_disabled when value is "0"', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, reviewDisabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('proj1', 'review_disabled', '0')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.reviewDisabled).toBeFalsy();
  });
});

describe('getProjectTestConfig — testsDisabled / reviewDisabled', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        workspace_path: '/workspace',
        github_owner: '',
        claude_bin: '~/.local/bin/claude',
        log_dir: '~/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
      }),
    }));
  });

  afterEach(() => { vi.resetModules(); });

  it('returns null for unknown project', async () => {
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    expect(fn('ghost')).toBeNull();
  });

  it('defaults testsDisabled to false when column is NULL', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.testsDisabled).toBe(false);
  });

  it('returns testsDisabled=true when column is set', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.testsDisabled).toBe(true);
  });

  it('defaults reviewDisabled to false when column is NULL', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.reviewDisabled).toBe(false);
  });

  it('returns reviewDisabled=true when column is set', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, reviewDisabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.reviewDisabled).toBe(true);
  });

  it('returns both flags independently — testsDisabled=true, reviewDisabled=false', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true, reviewDisabled: false }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.testsDisabled).toBe(true);
    expect(cfg?.reviewDisabled).toBe(false);
  });

  it('defaults issueAutoBranch to true when column is NULL', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.issueAutoBranch).toBe(true);
  });

  it('returns issueAutoBranch=false when explicitly set to false', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, issueAutoBranch: false }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.issueAutoBranch).toBe(false);
  });

  it('returns issueAutoBranch=true when explicitly set to true', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, issueAutoBranch: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.issueAutoBranch).toBe(true);
  });

  it('defaults autoPushEnabled to false when column is NULL', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.autoPushEnabled).toBe(false);
  });

  it('returns autoPushEnabled=true when set', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, autoPushEnabled: true }).run();
    const { getProjectTestConfig: fn } = await import('@/lib/scheduling/scheduling');
    const cfg = fn('proj1');
    expect(cfg?.autoPushEnabled).toBe(true);
  });

});

describe('getImproveConfig — logDir path expansion', () => {
  let testDb: ReturnType<typeof createTestDb>;

  function setupMocks(log_dir: string) {
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        workspace_path: '/workspace',
        github_owner: '',
        claude_bin: '/usr/bin/claude',
        log_dir,
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
        base_prompt: '',
        permission_mode: 'bypassPermissions',
      }),
    }));
  }

  afterEach(() => {
    vi.resetModules();
  });

  it('resolves ./relative path against process.cwd()', async () => {
    vi.resetModules();
    setupMocks('./data/logs');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), 'data/logs'));
  });

  it('resolves ../relative path against process.cwd()', async () => {
    vi.resetModules();
    setupMocks('../other-logs');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), '../other-logs'));
  });

  it('resolves bare relative path (no leading dot) against process.cwd()', async () => {
    vi.resetModules();
    setupMocks('logs/tamtam');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), 'logs/tamtam'));
  });

  it('expands ~/path to homedir', async () => {
    vi.resetModules();
    setupMocks('~/my-logs');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(homedir(), 'my-logs'));
  });

  it('returns absolute path unchanged', async () => {
    vi.resetModules();
    setupMocks('/var/log/tamtam');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const config = getImproveConfig();
    expect(config.logDir).toBe('/var/log/tamtam');
  });
});

describe('setProjectPushResult / getProjectPushResult', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({
        workspace_path: '/workspace',
        github_owner: '',
        claude_bin: '~/.local/bin/claude',
        log_dir: '~/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getProjectPushResult returns null for unknown project', async () => {
    const { getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    expect(getProjectPushResult('no-such-project')).toBeNull();
  });

  it('getProjectPushResult returns null error and null timestamp when project has no push history', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    const result = getProjectPushResult('proj1');
    expect(result).not.toBeNull();
    expect(result!.lastPushError).toBeNull();
    expect(result!.lastPushAt).toBeNull();
  });

  it('setProjectPushResult stores null error on success', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { setProjectPushResult, getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    setProjectPushResult('proj1', null);
    const result = getProjectPushResult('proj1');
    expect(result!.lastPushError).toBeNull();
    expect(result!.lastPushAt).toBeGreaterThan(0);
  });

  it('setProjectPushResult stores error string on failure', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { setProjectPushResult, getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    setProjectPushResult('proj1', 'Push failed: remote rejected');
    const result = getProjectPushResult('proj1');
    expect(result!.lastPushError).toBe('Push failed: remote rejected');
    expect(result!.lastPushAt).toBeGreaterThan(0);
  });

  it('setProjectPushResult overwrites a previous error with null', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { setProjectPushResult, getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    setProjectPushResult('proj1', 'previous error');
    setProjectPushResult('proj1', null);
    const result = getProjectPushResult('proj1');
    expect(result!.lastPushError).toBeNull();
  });

  it('setProjectPushResult updates lastPushAt on each call', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { setProjectPushResult, getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    setProjectPushResult('proj1', null);
    const first = getProjectPushResult('proj1')!.lastPushAt!;
    setProjectPushResult('proj1', null);
    const second = getProjectPushResult('proj1')!.lastPushAt!;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('setProjectPushResult is a no-op for unknown project', async () => {
    const { setProjectPushResult, getProjectPushResult } = await import('@/lib/scheduling/scheduling');
    expect(() => setProjectPushResult('ghost', 'err')).not.toThrow();
    expect(getProjectPushResult('ghost')).toBeNull();
  });
});
