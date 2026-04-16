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
} from '@/lib/scheduling';
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
      custom_actions TEXT
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
    vi.doMock('@/lib/config', () => ({
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
    const { writePriorityYaml: fn } = await import('@/lib/scheduling');
    expect(fn('nonexistent', null, 'high')).toBe(false);
  });

  it('updates priority for existing project', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writePriorityYaml: fn } = await import('@/lib/scheduling');
    expect(fn('proj1', null, 'high')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.priority).toBe('high');
  });

  it('clears priority when null is passed', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, priority: 'critical' }).run();
    const { writePriorityYaml: fn } = await import('@/lib/scheduling');
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
    vi.doMock('@/lib/config', () => ({
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
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling');
    expect(fn('nonexistent', 'github', 'owner/repo')).toBe(false);
  });

  it('updates github field', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling');
    expect(fn('proj1', 'github', 'owner/proj1')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.github).toBe('owner/proj1');
  });

  it('updates priority field', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling');
    expect(fn('proj1', 'priority', 'critical')).toBe(true);
    const row = testDb.db.select().from(schema.projects).get();
    expect(row?.priority).toBe('critical');
  });

  it('returns true for unknown field (no-op)', async () => {
    testDb.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true }).run();
    const { writeProjectFieldYaml: fn } = await import('@/lib/scheduling');
    expect(fn('proj1', 'unknown_field', 'value')).toBe(true);
  });
});
