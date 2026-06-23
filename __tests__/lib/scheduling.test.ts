import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyProjectsSchema(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value text NOT NULL
  )`));
  await handle.db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS projects (
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
    setup_complete boolean NOT NULL DEFAULT false,
    setup_state text NOT NULL DEFAULT '{}',
    archived boolean NOT NULL DEFAULT false,
    paused boolean NOT NULL DEFAULT false
  )`));
}

// Shared PGlite handle for every DB-using describe block below. Booted once
// per file and truncated between tests — was previously booted per-test
// (5 describes × ~7 tests × ~500ms boot ≈ 17s of pure setup).
let sharedHandle: TestDbHandle;

async function truncateProjects(): Promise<void> {
  await sharedHandle.db.execute(sql.raw('TRUNCATE projects, settings'));
}

const DEFAULT_SETTINGS = {
  workspace_path: '/workspace',
  github_owner: '',
  claude_bin: '~/.local/bin/claude',
  log_dir: '~/logs',
  frequency: '1h',
  daytime: false,
  weekends: false,
};

// Hoisted shared state for module-scope mocks. `currentSettings` is mutated
// per-test; the mocked `getSettings()` reads it lazily. `dbHolder.db` is
// populated in `beforeAll` so the module-scope db mock points at the shared
// PGlite handle for every test in this file.
const mockState = vi.hoisted(() => ({
  currentSettings: {} as Record<string, unknown>,
  dbHolder: { db: null as unknown as TestDbHandle['db'] },
}));

vi.mock('@/lib/shared/config', () => ({
  getSettings: () => mockState.currentSettings,
}));

vi.mock('@/lib/db', async () => {
  const realSchema = await vi.importActual<typeof import('@/lib/db/schema')>('@/lib/db/schema');
  return {
    get db() {
      return mockState.dbHolder.db;
    },
    schema: realSchema,
  };
});

// Import the subject once at top scope — see vitest convention guide.
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
  getImproveConfig,
  setProjectPushResult,
  getProjectPushResult,
} from '@/lib/scheduling/scheduling';
import { clearProjectsCache, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyProjectsSchema(sharedHandle);
  mockState.dbHolder.db = sharedHandle.db;
  mockState.currentSettings = { ...DEFAULT_SETTINGS };
});

afterAll(async () => {
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

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
  beforeEach(async () => {
    await truncateProjects();
    mockState.currentSettings = { ...DEFAULT_SETTINGS };
  });

  it('returns false when project does not exist', async () => {
    expect(await writePriorityYaml('nonexistent', null, 'high')).toBe(false);
  });

  it('updates priority for existing project', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writePriorityYaml('proj1', null, 'high')).toBe(true);
    // wait for fire-and-forget update
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.priority).toBe('high');
    }, { interval: 1, timeout: 1000 });
  });

  it('clears priority when null is passed', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, priority: 'critical' });
    await writePriorityYaml('proj1', null, null);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.priority).toBeNull();
    }, { interval: 1, timeout: 1000 });
  });
});

describe('writeProjectFieldYaml', () => {
  beforeEach(async () => {
    await truncateProjects();
    mockState.currentSettings = { ...DEFAULT_SETTINGS };
  });

  it('returns false when project does not exist', async () => {
    expect(await writeProjectFieldYaml('nonexistent', 'github', 'owner/repo')).toBe(false);
  });

  it('updates github field', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writeProjectFieldYaml('proj1', 'github', 'owner/proj1')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.github).toBe('owner/proj1');
    }, { interval: 1, timeout: 1000 });
  });

  it('updates priority field', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writeProjectFieldYaml('proj1', 'priority', 'critical')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.priority).toBe('critical');
    }, { interval: 1, timeout: 1000 });
  });

  it('returns false for unknown field name', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writeProjectFieldYaml('proj1', 'unknown_field', 'value')).toBe(false);
  });

  it('sets tests_disabled=true when value is "1"', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writeProjectFieldYaml('proj1', 'tests_disabled', '1')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.testsDisabled).toBe(true);
    }, { interval: 1, timeout: 1000 });
  });

  it('clears tests_disabled when value is "0"', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true });
    expect(await writeProjectFieldYaml('proj1', 'tests_disabled', '0')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.testsDisabled).toBeFalsy();
    }, { interval: 1, timeout: 1000 });
  });

  it('sets review_disabled=true when value is "1"', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    expect(await writeProjectFieldYaml('proj1', 'review_disabled', '1')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.reviewDisabled).toBe(true);
    }, { interval: 1, timeout: 1000 });
  });

  it('clears review_disabled when value is "0"', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, reviewDisabled: true });
    expect(await writeProjectFieldYaml('proj1', 'review_disabled', '0')).toBe(true);
    await vi.waitFor(async () => {
      const [row] = await sharedHandle.db.select().from(schema.projects);
      expect(row?.reviewDisabled).toBeFalsy();
    }, { interval: 1, timeout: 1000 });
  });
});

describe('getProjectTestConfig — testsDisabled / reviewDisabled', () => {
  beforeEach(async () => {
    await truncateProjects();
    mockState.currentSettings = { ...DEFAULT_SETTINGS };
  });

  it('returns null for unknown project', async () => {
    expect(await getProjectTestConfig('ghost')).toBeNull();
  });

  it('defaults testsDisabled to false when column is NULL', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.testsDisabled).toBe(false);
  });

  it('returns testsDisabled=true when column is set', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.testsDisabled).toBe(true);
  });

  it('defaults reviewDisabled to false when column is NULL', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.reviewDisabled).toBe(false);
  });

  it('returns reviewDisabled=true when column is set', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, reviewDisabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.reviewDisabled).toBe(true);
  });

  it('returns both flags independently — testsDisabled=true, reviewDisabled=false', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, testsDisabled: true, reviewDisabled: false });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.testsDisabled).toBe(true);
    expect(cfg?.reviewDisabled).toBe(false);
  });

  it('defaults issueAutoBranch to true when column is NULL', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.issueAutoBranch).toBe(true);
  });

  it('returns issueAutoBranch=false when explicitly set to false', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, issueAutoBranch: false });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.issueAutoBranch).toBe(false);
  });

  it('returns issueAutoBranch=true when explicitly set to true', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, issueAutoBranch: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.issueAutoBranch).toBe(true);
  });

  it('defaults autoPushEnabled to false when column is NULL', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.autoPushEnabled).toBe(false);
  });

  it('returns autoPushEnabled=true when set', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true, autoPushEnabled: true });
    const cfg = await getProjectTestConfig('proj1');
    expect(cfg?.autoPushEnabled).toBe(true);
  });

});

describe('getImproveConfig — logDir path expansion', () => {
  async function setupMocks(log_dir: string) {
    await truncateProjects();
    mockState.currentSettings = {
      workspace_path: '/workspace',
      github_owner: '',
      claude_bin: '/usr/bin/claude',
      log_dir,
      frequency: '1h',
      daytime: false,
      weekends: false,
      base_prompt: '',
      permission_mode: 'bypassPermissions',
    };
    // getImproveConfig calls listEnabledProjects (cached). Prime the cache
    // synchronously so it picks up the truncated state and not stale rows.
    clearProjectsCache();
    await refreshProjectsCacheSync();
  }

  afterEach(() => {
    mockState.currentSettings = { ...DEFAULT_SETTINGS };
  });

  it('resolves ./relative path against process.cwd()', async () => {
    await setupMocks('./data/logs');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), 'data/logs'));
  });

  it('resolves ../relative path against process.cwd()', async () => {
    await setupMocks('../other-logs');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), '../other-logs'));
  });

  it('resolves bare relative path (no leading dot) against process.cwd()', async () => {
    await setupMocks('logs/tamtam');
    const { join } = await import('path');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(process.cwd(), 'logs/tamtam'));
  });

  it('expands ~/path to homedir', async () => {
    await setupMocks('~/my-logs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const config = getImproveConfig();
    expect(config.logDir).toBe(join(homedir(), 'my-logs'));
  });

  it('returns absolute path unchanged', async () => {
    await setupMocks('/var/log/tamtam');
    const config = getImproveConfig();
    expect(config.logDir).toBe('/var/log/tamtam');
  });
});

describe('setProjectPushResult / getProjectPushResult', () => {
  beforeEach(async () => {
    await truncateProjects();
    mockState.currentSettings = { ...DEFAULT_SETTINGS };
  });

  it('getProjectPushResult returns null for unknown project', async () => {
    expect(await getProjectPushResult('no-such-project')).toBeNull();
  });

  it('getProjectPushResult returns null error and null timestamp when project has no push history', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    const result = await getProjectPushResult('proj1');
    expect(result).not.toBeNull();
    expect(result!.lastPushError).toBeNull();
    expect(result!.lastPushAt).toBeNull();
  });

  it('setProjectPushResult stores null error on success', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    setProjectPushResult('proj1', null);
    await vi.waitFor(async () => {
      const result = await getProjectPushResult('proj1');
      expect(result!.lastPushError).toBeNull();
      expect(result!.lastPushAt).toBeGreaterThan(0);
    }, { interval: 1, timeout: 1000 });
  });

  it('setProjectPushResult stores error string on failure', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    setProjectPushResult('proj1', 'Push failed: remote rejected');
    await vi.waitFor(async () => {
      const result = await getProjectPushResult('proj1');
      expect(result!.lastPushError).toBe('Push failed: remote rejected');
      expect(result!.lastPushAt).toBeGreaterThan(0);
    }, { interval: 1, timeout: 1000 });
  });

  it('setProjectPushResult overwrites a previous error with null', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    setProjectPushResult('proj1', 'previous error');
    await vi.waitFor(async () => {
      const r = await getProjectPushResult('proj1');
      expect(r!.lastPushError).toBe('previous error');
    }, { interval: 1, timeout: 1000 });
    setProjectPushResult('proj1', null);
    await vi.waitFor(async () => {
      const result = await getProjectPushResult('proj1');
      expect(result!.lastPushError).toBeNull();
    }, { interval: 1, timeout: 1000 });
  });

  it('setProjectPushResult updates lastPushAt on each call', async () => {
    await sharedHandle.db.insert(schema.projects).values({ name: 'proj1', path: '/p', enabled: true });
    setProjectPushResult('proj1', null);
    let first = 0;
    await vi.waitFor(async () => {
      const r = await getProjectPushResult('proj1');
      expect(r!.lastPushAt).toBeGreaterThan(0);
      first = r!.lastPushAt!;
    }, { interval: 1, timeout: 1000 });
    setProjectPushResult('proj1', null);
    await vi.waitFor(async () => {
      const r = await getProjectPushResult('proj1');
      expect(r!.lastPushAt).toBeGreaterThanOrEqual(first);
    }, { interval: 1, timeout: 1000 });
  });

  it('setProjectPushResult is a no-op for unknown project', async () => {
    expect(() => setProjectPushResult('ghost', 'err')).not.toThrow();
    expect(await getProjectPushResult('ghost')).toBeNull();
  });
});
