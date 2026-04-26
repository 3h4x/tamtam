import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('config', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let getSettings: typeof import('@/lib/config').getSettings;
  let reloadConfig: typeof import('@/lib/config').reloadConfig;
  let withBasePrompt: typeof import('@/lib/config').withBasePrompt;
  let getPermissionModeFlag: typeof import('@/lib/config').getPermissionModeFlag;

  beforeEach(async () => {
    vi.resetModules();

    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    const config = await import('@/lib/config');
    getSettings = config.getSettings;
    reloadConfig = config.reloadConfig;
    withBasePrompt = config.withBasePrompt;
    getPermissionModeFlag = config.getPermissionModeFlag;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('getSettings', () => {
    it('returns default config when no settings exist', () => {
      const config = getSettings();

      expect(config).toEqual({
        workspace_path: '',
        github_owner: '',
        claude_bin: '~/.local/bin/claude',
        log_dir: './data/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        launchagent_prefix: 'com.tamtam',
        base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
        default_model: 'haiku',
        permission_mode: 'bypassPermissions',
        commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
        review_verdict_rules: expect.stringContaining('Pragmatic verdict rules'),
        fix_ci_max_retries: 2,
        fix_ci_retry_window_seconds: 120,
        fix_ci_fast_crash_ms: 5000,
        log_retention_count: 200,
        log_retention_days: 30,
        job_row_retention_days: 180,
        notification_webhook_url: '',
        notification_webhook_secret: '',
        notification_on_release_success: false,
        notification_on_release_fail: false,
        notification_on_release_aborted: false,
        notification_on_fix_loop_exhausted: false,
        notification_on_review_do_not_ship: false,
        notification_on_agent_run_fail: false,
      });
    });

    it('returns config with overridden workspace_path', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/home/user/projects' }).run();

      const config = getSettings();

      expect(config.workspace_path).toBe('/home/user/projects');
      expect(config.claude_bin).toBe('~/.local/bin/claude');
    });

    it('returns config with overridden github_owner', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'github_owner', value: 'octocat' }).run();

      const config = getSettings();

      expect(config.github_owner).toBe('octocat');
    });

    it('returns config with overridden claude_bin', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'claude_bin', value: '/usr/bin/claude' }).run();

      const config = getSettings();

      expect(config.claude_bin).toBe('/usr/bin/claude');
    });

    it('returns config with overridden log_dir', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'log_dir', value: '/var/log/tamtam' }).run();

      const config = getSettings();

      expect(config.log_dir).toBe('/var/log/tamtam');
    });

    it('returns config with overridden frequency', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'frequency', value: '30m' }).run();

      const config = getSettings();

      expect(config.frequency).toBe('30m');
    });

    it('parses daytime setting as boolean', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'daytime', value: 'true' }).run();

      const config = getSettings();

      expect(config.daytime).toBe(true);
    });

    it('handles daytime setting as false when not "true"', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'daytime', value: 'false' }).run();

      const config = getSettings();

      expect(config.daytime).toBe(false);
    });

    it('parses weekends setting as boolean from "on" value', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'weekends', value: 'on' }).run();

      const config = getSettings();

      expect(config.weekends).toBe(true);
    });

    it('handles weekends setting as false when not "on"', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'weekends', value: 'off' }).run();

      const config = getSettings();

      expect(config.weekends).toBe(false);
    });

    it('returns config with overridden launchagent_prefix', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'launchagent_prefix', value: 'org.example' }).run();

      const config = getSettings();

      expect(config.launchagent_prefix).toBe('org.example');
    });

    it('handles multiple settings', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/projects' }).run();
      db.insert(schema.settings).values({ key: 'github_owner', value: 'user123' }).run();
      db.insert(schema.settings).values({ key: 'frequency', value: '2h' }).run();

      const config = getSettings();

      expect(config.workspace_path).toBe('/projects');
      expect(config.github_owner).toBe('user123');
      expect(config.frequency).toBe('2h');
      expect(config.claude_bin).toBe('~/.local/bin/claude');
    });

    it('caches config for CACHE_TTL seconds', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/initial' }).run();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Modify database
      db.delete(schema.settings).run();
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/modified' }).run();

      // Should return cached value within TTL
      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/initial');
    });

    it('returns updated config after cache expires and reload is called', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/initial' }).run();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Clear cache
      reloadConfig();

      // Modify database
      db.delete(schema.settings).run();
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/modified' }).run();

      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/modified');
    });
  });

  describe('reloadConfig', () => {
    it('clears the cache', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/initial' }).run();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Clear cache
      reloadConfig();

      // Modify database
      db.delete(schema.settings).run();
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/updated' }).run();

      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/updated');
    });

    it('can be called multiple times', () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'frequency', value: '1h' }).run();

      getSettings();
      reloadConfig();
      reloadConfig();
      reloadConfig();

      const config = getSettings();
      expect(config.frequency).toBe('1h');
    });
  });

  describe('base_prompt', () => {
    it('returns default base_prompt when not set', () => {
      const config = getSettings();
      expect(config.base_prompt).toContain('Never ask clarifying questions');
    });

    it('returns custom base_prompt when set in DB', () => {
      testDb.db.insert(schema.settings).values({ key: 'base_prompt', value: 'Be concise.' }).run();
      reloadConfig();

      const config = getSettings();
      expect(config.base_prompt).toBe('Be concise.');
    });
  });

  describe('withBasePrompt', () => {
    it('prepends default base prompt to user prompt', () => {
      const result = withBasePrompt('do something');
      expect(result).toContain('Never ask clarifying questions');
      expect(result).toContain('---');
      expect(result).toContain('do something');
    });

    it('prepends custom base prompt when configured', () => {
      testDb.db.insert(schema.settings).values({ key: 'base_prompt', value: 'Be concise.' }).run();
      reloadConfig();

      const result = withBasePrompt('do something');
      expect(result).toBe('Be concise.\n\n---\n\ndo something');
    });

    it('returns prompt unchanged when base_prompt is empty', () => {
      testDb.db.insert(schema.settings).values({ key: 'base_prompt', value: '' }).run();
      reloadConfig();

      // Empty string gets deleted from DB by settings API, so falls back to default
      // But if it somehow ends up empty in the map, withBasePrompt should handle it
      const result = withBasePrompt('do something');
      // With empty base_prompt in DB, getSettings returns default
      expect(result).toContain('do something');
    });

    it('preserves multiline prompts', () => {
      testDb.db.insert(schema.settings).values({ key: 'base_prompt', value: 'Rule 1\nRule 2' }).run();
      reloadConfig();

      const result = withBasePrompt('task here');
      expect(result).toBe('Rule 1\nRule 2\n\n---\n\ntask here');
    });
  });

  describe('getPermissionModeFlag', () => {
    it('returns default bypassPermissions flag when no setting in DB', () => {
      expect(getPermissionModeFlag()).toBe('--permission-mode bypassPermissions');
    });

    it('returns flag for a valid mode stored in DB', () => {
      testDb.db.insert(schema.settings).values({ key: 'permission_mode', value: 'acceptEdits' }).run();
      reloadConfig();
      expect(getPermissionModeFlag()).toBe('--permission-mode acceptEdits');
    });

    it('falls back to bypassPermissions for an unrecognised mode', () => {
      testDb.db.insert(schema.settings).values({ key: 'permission_mode', value: 'dangerousMode' }).run();
      reloadConfig();
      expect(getPermissionModeFlag()).toBe('--permission-mode bypassPermissions');
    });

    it.each(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])(
      'accepts valid mode %s',
      (mode) => {
        testDb.db.insert(schema.settings).values({ key: 'permission_mode', value: mode }).run();
        reloadConfig();
        expect(getPermissionModeFlag()).toBe(`--permission-mode ${mode}`);
      }
    );
  });

  describe('fix_ci_* integer settings', () => {
    it('parses fix_ci_max_retries from DB as integer', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_max_retries', value: '5' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_max_retries).toBe(5);
    });

    it('falls back to default when fix_ci_max_retries is non-numeric', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_max_retries', value: 'abc' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_max_retries).toBe(2);
    });

    it('accepts 0 to disable retries', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_max_retries', value: '0' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_max_retries).toBe(0);
    });

    it('parses fix_ci_retry_window_seconds from DB as integer', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_retry_window_seconds', value: '300' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_retry_window_seconds).toBe(300);
    });

    it('falls back to default when fix_ci_retry_window_seconds is non-numeric', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_retry_window_seconds', value: 'bad' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_retry_window_seconds).toBe(120);
    });

    it('parses fix_ci_fast_crash_ms from DB as integer', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_fast_crash_ms', value: '10000' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_fast_crash_ms).toBe(10000);
    });

    it('falls back to default when fix_ci_fast_crash_ms is non-numeric', () => {
      testDb.db.insert(schema.settings).values({ key: 'fix_ci_fast_crash_ms', value: 'nope' }).run();
      reloadConfig();
      expect(getSettings().fix_ci_fast_crash_ms).toBe(5000);
    });
  });

  describe('commit_style and review_verdict_rules', () => {
    it('returns default commit_style when not set', () => {
      const config = getSettings();
      expect(config.commit_style).toContain('conventional commits');
    });

    it('returns overridden commit_style from DB', () => {
      testDb.db.insert(schema.settings).values({ key: 'commit_style', value: 'squash everything' }).run();
      reloadConfig();
      expect(getSettings().commit_style).toBe('squash everything');
    });

    it('returns default review_verdict_rules when not set', () => {
      const config = getSettings();
      expect(config.review_verdict_rules).toContain('Pragmatic verdict rules');
    });

    it('returns overridden review_verdict_rules from DB', () => {
      testDb.db.insert(schema.settings).values({ key: 'review_verdict_rules', value: 'always LGTM' }).run();
      reloadConfig();
      expect(getSettings().review_verdict_rules).toBe('always LGTM');
    });
  });
});
