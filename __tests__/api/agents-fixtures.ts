import { describe, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

// Hoisted holders shared across module-scoped mocks. `dbHolder` is filled in
// `beforeAll` once PGlite boots; mock factories close over the holder rather
// than a value, so they see the live db when the route handlers call them.
const dbHolder = vi.hoisted(() => ({ db: null as TestDbHandle['db'] | null }));

const mocks = vi.hoisted(() => ({
  installAgentSchedule: vi.fn().mockResolvedValue(undefined),
  uninstallAgentSchedule: vi.fn().mockResolvedValue(undefined),
  resolveProjectPath: vi.fn().mockReturnValue(null as string | null),
  clearProjectDataCache: vi.fn(),
  getEnabledProjects: vi.fn().mockReturnValue({}),
  scanFileAgents: vi.fn().mockReturnValue([]),
  renameFileAgent: vi.fn().mockReturnValue(null),
  loadFileAgent: vi.fn().mockReturnValue(null),
  parseFileAgentId: vi.fn().mockReturnValue(null),
  writeFileAgent: vi.fn().mockReturnValue(null),
  deleteFileAgent: vi.fn(),
  getFileAgentOverride: vi.fn().mockReturnValue(null),
  getFileAgentOverrideSync: vi.fn().mockReturnValue(null),
  setFileAgentOverride: vi.fn().mockImplementation((_p: string, _n: string, patch) => patch),
  deleteFileAgentOverride: vi.fn(),
}));

const cronStateMocks = vi.hoisted(() => ({
  loadAgentCronStates: vi.fn().mockResolvedValue(new Map()),
  getAllAgentLastAttempts: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('@/lib/db', () => ({
  get db() { return dbHolder.db!; },
  schema,
}));

vi.mock('@/lib/scheduling/agent-scheduler', () => ({
  installAgentSchedule: mocks.installAgentSchedule,
  uninstallAgentSchedule: mocks.uninstallAgentSchedule,
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
  clearProjectDataCache: mocks.clearProjectDataCache,
  getEnabledProjects: mocks.getEnabledProjects,
}));

// The file-agent feature was removed — agents live only in the DB. The mock
// holders above remain as inert vi.fn()s so existing test callers still
// compile, but no module is wired to them anymore.

vi.mock('@/lib/scheduling/agent-cron-state', () => ({
  loadAgentCronStates: cronStateMocks.loadAgentCronStates,
  getAllAgentLastAttempts: cronStateMocks.getAllAgentLastAttempts,
}));

import { clearAgentsCache, getAllAgentsCachedAsync } from '@/lib/agents/agents-cache';
import { clearProjectsCache, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';

export let GET: typeof import('@/app/api/agents/route').GET;
export let POST: typeof import('@/app/api/agents/route').POST;
export let agentGET: typeof import('@/app/api/agents/[agentId]/route').GET;
export let PATCH: typeof import('@/app/api/agents/[agentId]/route').PATCH;
export let DELETE: typeof import('@/app/api/agents/[agentId]/route').DELETE;
export let PATCH_BY_NAME: typeof import('@/app/api/agents/by-name/route').PATCH;

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'sonnet',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
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
      pr_workflow_enabled boolean DEFAULT false,
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
    CREATE TABLE IF NOT EXISTS agent_revisions (
      id serial PRIMARY KEY,
      entity_id text NOT NULL,
      snapshot text NOT NULL,
      author text NOT NULL,
      note text,
      created_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id serial PRIMARY KEY,
      entity_id text NOT NULL,
      snapshot text NOT NULL,
      author text NOT NULL,
      note text,
      created_at double precision NOT NULL
    )
  `));
}

export type AgentsApiContext = {
  testDb: { db: TestDbHandle['db'] };
  mocks: typeof mocks;
  installAgentScheduleMock: typeof mocks.installAgentSchedule;
  uninstallAgentScheduleMock: typeof mocks.uninstallAgentSchedule;
  scanFileAgentsMock: typeof mocks.scanFileAgents;
  renameFileAgentMock: typeof mocks.renameFileAgent;
  parseFileAgentIdMock: typeof mocks.parseFileAgentId;
  loadFileAgentMock: typeof mocks.loadFileAgent;
  writeFileAgentMock: typeof mocks.writeFileAgent;
  deleteFileAgentMock: typeof mocks.deleteFileAgent;
  setFileAgentOverrideMock: typeof mocks.setFileAgentOverride;
  resolveProjectPathMock: typeof mocks.resolveProjectPath;
  loadAgentCronStatesMock: typeof cronStateMocks.loadAgentCronStates;
  getAllAgentLastAttemptsMock: typeof cronStateMocks.getAllAgentLastAttempts;
  warmAgentsCache: () => Promise<void>;
};

export function describeAgentsApi(register: (ctx: AgentsApiContext) => void): void {
  describe('agents API', () => {
    let sharedHandle: TestDbHandle;
    const testDb = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
    const installAgentScheduleMock = mocks.installAgentSchedule;
    const uninstallAgentScheduleMock = mocks.uninstallAgentSchedule;
    const scanFileAgentsMock = mocks.scanFileAgents;
    const renameFileAgentMock = mocks.renameFileAgent;
    const parseFileAgentIdMock = mocks.parseFileAgentId;
    const loadFileAgentMock = mocks.loadFileAgent;
    const writeFileAgentMock = mocks.writeFileAgent;
    const deleteFileAgentMock = mocks.deleteFileAgent;
    const setFileAgentOverrideMock = mocks.setFileAgentOverride;
    const resolveProjectPathMock = mocks.resolveProjectPath;
    const loadAgentCronStatesMock = cronStateMocks.loadAgentCronStates;
    const getAllAgentLastAttemptsMock = cronStateMocks.getAllAgentLastAttempts;

    beforeAll(async () => {
      sharedHandle = await createTestPgDbEmpty();
      await applyDdl(sharedHandle);
      dbHolder.db = sharedHandle.db;

      const agentsRoute = await import('@/app/api/agents/route');
      GET = agentsRoute.GET;
      POST = agentsRoute.POST;

      const agentRoute = await import('@/app/api/agents/[agentId]/route');
      agentGET = agentRoute.GET;
      PATCH = agentRoute.PATCH;
      DELETE = agentRoute.DELETE;

      const byNameRoute = await import('@/app/api/agents/by-name/route');
      PATCH_BY_NAME = byNameRoute.PATCH;
    });

    afterAll(async () => {
      try {
        await sharedHandle[Symbol.asyncDispose]();
      } catch {
        // ignore
      }
    });

    // Monotonic clock advanced 60s per test so the route's internal 10s
    // file-agent cache (`_allFileAgentsCache`) expires between tests. The
    // route module is imported once now, so the cache survives across tests
    // unless we move wall-clock time forward. Forward-only Date.now keeps the
    // existing `updatedAt`-comparing assertions valid because both the route
    // and the test read the same mocked clock.
    let clockBase = Date.now();
    beforeEach(async () => {
      await sharedHandle.db.execute(sql.raw('TRUNCATE agents, projects, agent_revisions, skill_revisions RESTART IDENTITY'));
      clockBase += 60_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clockBase);

      // Reset call state on every mock but reinstall default return values so
      // individual tests can override with mockReturnValueOnce / mockImplementation.
      for (const fn of Object.values(mocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
      mocks.installAgentSchedule.mockResolvedValue(undefined);
      mocks.uninstallAgentSchedule.mockResolvedValue(undefined);
      mocks.resolveProjectPath.mockReturnValue(null);
      mocks.getEnabledProjects.mockReturnValue({});
      mocks.scanFileAgents.mockReturnValue([]);
      mocks.renameFileAgent.mockReturnValue(null);
      mocks.loadFileAgent.mockReturnValue(null);
      mocks.parseFileAgentId.mockReturnValue(null);
      mocks.writeFileAgent.mockReturnValue(null);
      mocks.getFileAgentOverride.mockReturnValue(null);
      mocks.setFileAgentOverride.mockImplementation((_p: string, _n: string, patch) => patch);
      cronStateMocks.loadAgentCronStates.mockResolvedValue(new Map());
      cronStateMocks.getAllAgentLastAttempts.mockReturnValue(new Map());

      // Module-level caches must be cleared between tests since the route module
      // is imported once and persists state across runs.
      clearAgentsCache();
      clearProjectsCache();
    });

    afterEach(() => {
      // Restore Date.now spy; do not touch hoisted module mocks.
      vi.mocked(Date.now).mockRestore?.();
    });

    // GET routes call getAllAgentsCached (sync) which returns [] while the
    // async refresh runs in the background. Tests that seed via direct
    // db.insert must warm the cache before invoking GET so the route sees the
    // freshly inserted rows. The route also reads enabled projects through a
    // sibling cache that needs the same treatment for unfiltered GETs.
    async function warmAgentsCache() {
      clearAgentsCache();
      await getAllAgentsCachedAsync();
      clearProjectsCache();
      await refreshProjectsCacheSync();
    }

    register({
      testDb,
      mocks,
      installAgentScheduleMock,
      uninstallAgentScheduleMock,
      scanFileAgentsMock,
      renameFileAgentMock,
      parseFileAgentIdMock,
      loadFileAgentMock,
      writeFileAgentMock,
      deleteFileAgentMock,
      setFileAgentOverrideMock,
      resolveProjectPathMock,
      loadAgentCronStatesMock,
      getAllAgentLastAttemptsMock,
      warmAgentsCache,
    });
  });
}
