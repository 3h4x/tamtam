import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';
import { autoSeededCatalogEntries } from '@/lib/agents/catalog';

const SYSTEM_AGENT_NAME = 'documentation-reindex-vectors';
// Number of auto-seed catalog entries materialized per enabled project
// (currently the internal doc-reindex agent + the CLI health monitor). Kept
// data-driven so adding another auto-seed built-in doesn't silently break these
// count assertions.
const AUTO_SEED_COUNT = autoSeededCatalogEntries().length;

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
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'normal',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      doc_paths text NOT NULL DEFAULT '[]',
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

describe('system-agent seed', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, projects, settings RESTART IDENTITY CASCADE'));
    vi.resetModules();
  });

  it('seeds one documentation-reindex-vectors row per enabled project', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
      { name: 'proj-b', path: '/tmp/b', enabled: true },
      { name: 'proj-c', path: '/tmp/c', enabled: false },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
        { name: 'proj-b', path: '/tmp/b', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    const result = await seedSystemAgents();

    expect(result.seeded).toBe(2 * AUTO_SEED_COUNT);
    expect(result.dismissed).toBe(0);

    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(2 * AUTO_SEED_COUNT);
    // The doc-reindex system agent is seeded once per enabled project.
    const docRows = rows.filter((r) => r.name === SYSTEM_AGENT_NAME);
    expect(docRows).toHaveLength(2);
    expect(docRows.every((r) => r.kind === 'system')).toBe(true);
    expect(new Set(docRows.map((r) => r.project))).toEqual(new Set(['proj-a', 'proj-b']));
  });

  it('seeds the health monitor as a kind:user non-boostable monitor per project', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    await seedSystemAgents();

    const rows = await sharedHandle.db.select().from(schema.agents);
    const health = rows.find((r) => r.name === 'health');
    expect(health).toBeDefined();
    expect(health!.kind).toBe('user');
    expect(health!.role).toBe('monitor');
    expect(health!.boostable).toBe(false);
    expect(health!.schedule).toBe('1h');
    expect(health!.model).toBe('claude-haiku-4-5-20251001');
    expect(JSON.parse(health!.skillIds)).toContain('agent-health');
  });

  it('is idempotent — re-running does not duplicate rows', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    await seedSystemAgents();
    const result = await seedSystemAgents();

    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(AUTO_SEED_COUNT);
    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(AUTO_SEED_COUNT);
  });

  it('skips seeding when a DB agent has a case-insensitive name conflict', async () => {
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
    ]);
    await sharedHandle.db.insert(schema.agents).values({
      id: 'user-agent',
      name: 'Documentation-Reindex-Vectors',
      project: 'proj-a',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'user-owned',
      schedule: null,
      enabled: true,
      kind: 'user',
      createdAt: now,
      updatedAt: now,
    });

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    const result = await seedSystemAgents();

    // The doc-reindex name conflicts and is skipped; the other auto-seed
    // entries (health) still seed.
    expect(result.seeded).toBe(AUTO_SEED_COUNT - 1);
    expect(result.skipped).toBe(1);
    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(AUTO_SEED_COUNT);
    expect(rows.some((r) => r.id === 'user-agent')).toBe(true);
    // No system-kind doc-reindex row was seeded — only the pre-existing user one bears that name.
    expect(rows.filter((r) => r.name === SYSTEM_AGENT_NAME && r.kind === 'system')).toHaveLength(0);
  });

  it('skips seeding when a user agent has the same canonical name', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
    ]);
    const now = Date.now() / 1000;
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-user',
      name: 'Documentation-Reindex-Vectors',
      project: 'proj-a',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'user-owned',
      schedule: null,
      enabled: true,
      kind: 'user',
      createdAt: now,
      updatedAt: now,
    });

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    const result = await seedSystemAgents();

    // The doc-reindex canonical name conflicts and is skipped; the health
    // auto-seed entry still seeds.
    expect(result.seeded).toBe(AUTO_SEED_COUNT - 1);
    expect(result.skipped).toBe(1);
    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(AUTO_SEED_COUNT);
    expect(rows.some((r) => r.id === 'agent-user')).toBe(true);
    // No new doc-reindex row was seeded over the pre-existing user agent.
    expect(rows.filter((r) => r.name === SYSTEM_AGENT_NAME && r.kind === 'system')).toHaveLength(0);
  });

  it('honors the dismissal marker — skips seeding for that project/agent', async () => {
    await sharedHandle.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/tmp/a', enabled: true },
      { name: 'proj-b', path: '/tmp/b', enabled: true },
    ]);
    await sharedHandle.db.insert(schema.settings).values({
      key: `system_agent_dismissed:proj-a:${SYSTEM_AGENT_NAME}`,
      value: 'true',
    });

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [
        { name: 'proj-a', path: '/tmp/a', archived: false, paused: false },
        { name: 'proj-b', path: '/tmp/b', archived: false, paused: false },
      ],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgents } = await import('@/lib/agents/system/seed');
    const result = await seedSystemAgents();

    // proj-a: doc-reindex dismissed (health still seeds); proj-b: all seed.
    expect(result.seeded).toBe(2 * AUTO_SEED_COUNT - 1);
    expect(result.dismissed).toBe(1);
    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(2 * AUTO_SEED_COUNT - 1);
    // proj-a did NOT get the dismissed doc-reindex row.
    expect(rows.filter((r) => r.project === 'proj-a' && r.name === SYSTEM_AGENT_NAME)).toHaveLength(0);
  });

  it('seedSystemAgentsForProject targets a single project', async () => {
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { seedSystemAgentsForProject } = await import('@/lib/agents/system/seed');
    const result = await seedSystemAgentsForProject('proj-x');

    expect(result.seeded).toBe(AUTO_SEED_COUNT);
    const rows = await sharedHandle.db.select().from(schema.agents);
    expect(rows).toHaveLength(AUTO_SEED_COUNT);
    expect(rows.every((r) => r.project === 'proj-x')).toBe(true);
    expect(rows.find((r) => r.name === SYSTEM_AGENT_NAME)?.kind).toBe('system');
  });

  it('markSystemAgentDismissed writes the settings marker', async () => {
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/shared/enabled-projects', () => ({
      listEnabledProjects: () => [],
      refreshProjectsCacheSync: async () => undefined,
    }));

    const { markSystemAgentDismissed } = await import('@/lib/agents/system/seed');
    await markSystemAgentDismissed('proj-a', SYSTEM_AGENT_NAME);

    const rows = await sharedHandle.db
      .select()
      .from(schema.settings)
      .where(sql`key = ${`system_agent_dismissed:proj-a:${SYSTEM_AGENT_NAME}`}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('true');
  });
});
