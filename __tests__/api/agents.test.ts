import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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
  setFileAgentOverride: vi.fn().mockImplementation((_p: string, _n: string, patch) => patch),
  deleteFileAgentOverride: vi.fn(),
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

vi.mock('@/lib/agents/tamtam-file-agents', () => ({
  scanFileAgents: mocks.scanFileAgents,
  renameFileAgent: mocks.renameFileAgent,
  loadFileAgent: mocks.loadFileAgent,
  parseFileAgentId: mocks.parseFileAgentId,
  writeFileAgent: mocks.writeFileAgent,
  deleteFileAgent: mocks.deleteFileAgent,
}));

vi.mock('@/lib/agents/file-agent-overrides', () => ({
  getFileAgentOverride: mocks.getFileAgentOverride,
  setFileAgentOverride: mocks.setFileAgentOverride,
  deleteFileAgentOverride: mocks.deleteFileAgentOverride,
}));

// Import route handlers once at top scope. They resolve their mocked deps via
// the module-scoped `vi.mock` calls above.
import { GET, POST } from '@/app/api/agents/route';
import { GET as agentGET, PATCH, DELETE } from '@/app/api/agents/[agentId]/route';
import { PATCH as PATCH_BY_NAME } from '@/app/api/agents/by-name/route';
import { clearAgentsCache, getAllAgentsCachedAsync } from '@/lib/agents/agents-cache';
import { clearProjectsCache, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';

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
      runner text NOT NULL DEFAULT 'pm2',
      enabled boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
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
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
}

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

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    dbHolder.db = sharedHandle.db;
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
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, projects'));
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

  describe('GET /agents', () => {
    it('returns empty list of agents initially', async () => {
      const request = new NextRequest('http://localhost/api/agents');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toEqual([]);
    });

    it('returns all agents', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-1',
          name: 'Agent 1',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      await db.insert(schema.agents)
        .values({
          id: 'agent-2',
          name: 'Agent 2',
          project: 'proj2',
          skillIds: '["skill1"]',
          model: 'opus',
          prompt: 'Do something',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });
      await warmAgentsCache();

      const request = new NextRequest('http://localhost/api/agents');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(2);
      expect(data.agents[0].id).toBe('agent-1');
      expect(data.agents[1].id).toBe('agent-2');
    });

    it('filters agents by name', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
      await db.insert(schema.agents).values({ id: 'agent-2', name: 'Beta', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
      await warmAgentsCache();

      const request = new NextRequest('http://localhost/api/agents?name=Alpha');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('filters agents by project and name', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
      await db.insert(schema.agents).values({ id: 'agent-2', name: 'Alpha', project: 'proj2', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
      await warmAgentsCache();

      const request = new NextRequest('http://localhost/api/agents?project=proj1&name=Alpha');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('filters agents by project', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-1',
          name: 'Agent 1',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      await db.insert(schema.agents)
        .values({
          id: 'agent-2',
          name: 'Agent 2',
          project: 'proj2',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      await warmAgentsCache();

      const request = new NextRequest('http://localhost/api/agents?project=proj1');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('merges file agents from all enabled projects on unfiltered GET', async () => {
      const db = testDb.db;
      await db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true });
      await db.insert(schema.projects).values({ name: 'proj2', path: '/p2', enabled: true });
      await db.insert(schema.projects).values({ name: 'projDisabled', path: '/pd', enabled: false });

      scanFileAgentsMock.mockImplementation((path: string, project: string) => {
        if (project === 'proj1') {
          return [{
            id: 'file:proj1:fa1', name: 'fa1', project: 'proj1',
            skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
            source: 'file', filePath: `${path}/.tamtam/agents/fa1.md`,
          }];
        }
        if (project === 'proj2') {
          return [{
            id: 'file:proj2:fa2', name: 'fa2', project: 'proj2',
            skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
            source: 'file', filePath: `${path}/.tamtam/agents/fa2.md`,
          }];
        }
        return [];
      });
      await warmAgentsCache();

      const response = await GET(new NextRequest('http://localhost/api/agents'));
      const data = await response.json();

      const ids = data.agents.map((a: { id: string }) => a.id).sort();
      expect(ids).toEqual(['file:proj1:fa1', 'file:proj2:fa2']);
      // Disabled project must not be scanned
      const calledProjects = scanFileAgentsMock.mock.calls.map(c => c[1]);
      expect(calledProjects).not.toContain('projDisabled');
    });

    it('DB agent takes precedence over file agent with same project+name on unfiltered GET', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true });
      await db.insert(schema.agents).values({
        id: 'db-1', name: 'shared', project: 'proj1', skillIds: '[]',
        model: 'sonnet', prompt: 'db version', schedule: null,
        createdAt: now, updatedAt: now,
      });

      scanFileAgentsMock.mockReturnValue([{
        id: 'file:proj1:shared', name: 'shared', project: 'proj1',
        skillIds: [], docPaths: [], model: 'sonnet', prompt: 'file version', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file', filePath: '/p1/.tamtam/agents/shared.md',
      }]);
      await warmAgentsCache();

      const response = await GET(new NextRequest('http://localhost/api/agents'));
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('db-1');
      expect(data.agents[0].prompt).toBe('db version');
    });
  });

  describe('POST /agents', () => {
    it('creates agent successfully', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      expect(data.agent.name).toBe('New Agent');
      expect(data.agent.project).toBe('proj1');
      expect(data.agent.model).toBe('normal');
    });

    it('validates required fields', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: '', project: '' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('required');
    });

    it('rejects unsafe agent names on create', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'bad/name', project: 'proj1' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('slashes'),
      });
    });

    it('trims whitespace from name and project', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: '  Agent  ', project: '  proj1  ' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.name).toBe('Agent');
      expect(data.agent.project).toBe('proj1');
    });

    it('rejects duplicate agent names within the same project', async () => {
      const now = Date.now() / 1000;
      await testDb.db.insert(schema.agents).values({
        id: 'agent-existing',
        name: 'Agent',
        project: 'proj1',
        skillIds: '[]',
        model: 'normal',
        prompt: '',
        schedule: null,

        createdAt: now,
        updatedAt: now,
      });

      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: ' Agent ', project: 'proj1' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects case-only duplicate agent names within the same project', async () => {
      const now = Date.now() / 1000;
      await testDb.db.insert(schema.agents).values({
        id: 'agent-existing',
        name: 'Agent',
        project: 'proj1',
        skillIds: '[]',
        model: 'normal',
        prompt: '',
        schedule: null,

        createdAt: now,
        updatedAt: now,
      });

      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'agent', project: 'proj1' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects duplicate names when a file agent already exists for the project', async () => {
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:proj1:Agent',
        name: 'Agent',
        project: 'proj1',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: '',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/proj1/.tamtam/agents/Agent.md',
      }]);

      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects case-only duplicates when a file agent already exists for the project', async () => {
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:proj1:Agent',
        name: 'Agent',
        project: 'proj1',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: '',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/proj1/.tamtam/agents/Agent.md',
      }]);

      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'agent', project: 'proj1' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('uses default model if not provided', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.model).toBe('normal');
    });

    it('accepts optional fields', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Agent',
          project: 'proj1',
          skillIds: ['skill1', 'skill2'],
          model: 'opus',
          prompt: 'Do something',
          schedule: '30m',

        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.model).toBe('smart');
      expect(data.agent.prompt).toBe('Do something');
      expect(data.agent.schedule).toBe('30m');
      expect(data.agent.skillIds).toEqual(['skill1', 'skill2']);
    });

    it('rejects invalid model values on create', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', model: 'smart --resume injected' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
    });

    it('rejects invalid schedule values on create', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1w' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid schedule'),
      });
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('normalizes schedule values on create before persisting and scheduling', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', prompt: 'Do something', schedule: ' 15M ' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.schedule).toBe('15m');
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        data.agent.id,
        '15m',
        'Do something',
        'proj1',
        'Agent'
      );
    });

    it('stores agent in database', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      const data = await response.json();
      const agentId = data.agent.id;

      // Verify response is valid
      expect(agentId).toBeTruthy();
      expect(data.agent).toBeTruthy();
    });

    it('defaults issue-cruncher agents to the trusted-only prerequisite command', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'issue-cruncher',
          project: 'proj1',
          skillIds: ['agent-issue-cruncher'],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.agent.prerequisiteCommand).toBe(
        'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'
      );

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
      expect(row?.prerequisiteCommand).toBe(
        'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'
      );
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank on create', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'issue-cruncher',
          project: 'proj1',
          skillIds: ['agent-issue-cruncher'],
          prerequisiteCommand: '',
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.agent.prerequisiteCommand).toBeNull();

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
      expect(row?.prerequisiteCommand).toBe('');
    });

    it('returns 400 when project is missing instead of throwing during prerequisite resolution', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'issue-cruncher',
          skillIds: ['agent-issue-cruncher'],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.detail).toBe('project is required');
    });
  });

  describe('GET /agents/{agentId}', () => {
    it('returns 404 for nonexistent agent', async () => {
      const response = await agentGET(
        new NextRequest('http://localhost/api/agents/nonexistent'),
        { params: Promise.resolve({ agentId: 'nonexistent' }) }
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.detail).toBe('not found');
    });

    it('returns agent by ID', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Test Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'Do stuff',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const response = await agentGET(
        new NextRequest('http://localhost/api/agents/agent-123'),
        { params: Promise.resolve({ agentId: 'agent-123' }) }
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agent.id).toBe('agent-123');
      expect(data.agent.name).toBe('Test Agent');
      expect(data.agent.project).toBe('proj1');
    });

    it('returns the effective issue-cruncher prerequisite when the stored row is blank', async () => {
      const now = Date.now() / 1000;
      await testDb.db.insert(schema.agents).values({
        id: 'agent-issue',
        name: 'Issue Cruncher',
        project: 'proj1',
        skillIds: '["agent-issue-cruncher"]',
        model: 'normal',
        prompt: '',
        schedule: null,

        prerequisiteCommand: null,
        createdAt: now,
        updatedAt: now,
      });

      const response = await agentGET(
        new NextRequest('http://localhost/api/agents/agent-issue'),
        { params: Promise.resolve({ agentId: 'agent-issue' }) }
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.agent.prerequisiteCommand).toBe(
        'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1"'
      );
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank in GET responses', async () => {
      const now = Date.now() / 1000;
      await testDb.db.insert(schema.agents).values({
        id: 'agent-issue-cleared',
        name: 'Issue Cruncher',
        project: 'proj1',
        skillIds: '["agent-issue-cruncher"]',
        model: 'normal',
        prompt: '',
        schedule: null,

        prerequisiteCommand: '',
        createdAt: now,
        updatedAt: now,
      });

      const response = await agentGET(
        new NextRequest('http://localhost/api/agents/agent-issue-cleared'),
        { params: Promise.resolve({ agentId: 'agent-issue-cleared' }) }
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.agent.prerequisiteCommand).toBeNull();
    });
  });

  describe('PATCH /agents/{agentId}', () => {
    it('returns 404 for nonexistent agent', async () => {
      const request = new NextRequest('http://localhost/api/agents/nonexistent', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'nonexistent' }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.detail).toBe('not found');
    });

    it('updates agent name', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agent.name).toBe('New Name');
    });

    it('rejects unsafe agent names on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'bad/name' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('slashes'),
      });
    });

    it('rejects duplicate agent names on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      await db.insert(schema.agents)
        .values({
          id: 'agent-456',
          name: 'Taken',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: ' Taken ' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects case-only duplicate agent names on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      await db.insert(schema.agents)
        .values({
          id: 'agent-456',
          name: 'Taken',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'taken' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects names that collide with file agents on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:proj1:Taken',
        name: 'Taken',
        project: 'proj1',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: '',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/proj1/.tamtam/agents/Taken.md',
      }]);

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Taken' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('rejects case-only names that collide with file agents on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:proj1:Taken',
        name: 'Taken',
        project: 'proj1',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: '',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/proj1/.tamtam/agents/Taken.md',
      }]);

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'taken' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('updates agent model and prompt', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'old prompt',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ model: 'opus', prompt: 'new prompt' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      const data = await response.json();
      expect(data.agent.model).toBe('smart');
      expect(data.agent.prompt).toBe('new prompt');
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank after PATCH by id', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-issue',
          name: 'Issue Cruncher',
          project: 'proj1',
          skillIds: '["agent-issue-cruncher"]',
          model: 'normal',
          prompt: '',
          schedule: null,

          prerequisiteCommand: 'echo old',
          createdAt: now,
          updatedAt: now,
        });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');

      const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-issue', {
        method: 'PATCH',
        body: JSON.stringify({ prerequisiteCommand: '' }),
      }), {
        params: Promise.resolve({ agentId: 'agent-issue' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agent.prerequisiteCommand).toBeNull();

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-issue');
      expect(row?.prerequisiteCommand).toBe('');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/proj1', 'proj1', 'Issue Cruncher', expect.objectContaining({
        prerequisiteCommand: '',
      }));
    });

    it('rejects invalid model values on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'old prompt',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ model: 'smart --resume injected' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
    });

    it('rejects invalid schedule values on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'old prompt',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '1w' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid schedule'),
      });
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('updates skillIds as JSON array', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ skillIds: ['skill1', 'skill2'] }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      const data = await response.json();
      expect(data.agent.skillIds).toEqual(['skill1', 'skill2']);
    });

    it('clears schedule when empty string provided', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do things',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      const data = await response.json();
      expect(data.agent.schedule).toBeNull();
    });

    it('updates updatedAt timestamp', async () => {
      const db = testDb.db;
      const oldTime = Date.now() / 1000 - 100;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: oldTime,
          updatedAt: oldTime,
        });

      const before = Date.now() / 1000;

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      const data = await response.json();
      expect(data.agent.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('returns 404 for file agent when project path is unknown', async () => {
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      // resolveProjectPath returns null by default
      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'new prompt' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });
      expect(response.status).toBe(404);
    });

    it('returns 404 for file agent when the .md file does not exist', async () => {
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      // loadFileAgent returns null by default — file absent
      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'new prompt' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });
      expect(response.status).toBe(404);
    });

    it('writes and returns updated file agent', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'new prompt', schedule: null,
 enabled: true, provider: 'codex', createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      // The route calls loadFileAgent twice — once to verify existence,
      // once after writes to return the merged result.
      loadFileAgentMock.mockReturnValue(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'new prompt' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agent.id).toBe('file:myproj:my-agent');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: 'new prompt',
        provider: undefined,
      });
    });

    it('persists provider-only updates for file agents', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'existing prompt', schedule: null,
 enabled: true, provider: 'codex', createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'codex' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(200);
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: undefined,
        provider: 'codex',
      });
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank for file agents by id', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: ['agent-issue-cruncher'] as string[], model: 'sonnet', prompt: 'existing prompt', schedule: null,
 enabled: true, provider: null, prerequisiteCommand: 'echo old', createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, prerequisiteCommand: '' };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValueOnce(existingAgent).mockReturnValueOnce(updatedAgent);
      writeFileAgentMock.mockReturnValueOnce(updatedAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ prerequisiteCommand: '' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.agent.prerequisiteCommand).toBeNull();
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: undefined,
        provider: undefined,
        prerequisiteCommand: '',
      });
    });

    it('clears file-agent provider frontmatter when provider is set to null', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'existing prompt', schedule: null,
 enabled: true, provider: null, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ provider: null }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(200);
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: undefined,
        provider: null,
      });
    });

    it('rejects invalid model values for file agents', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'new prompt', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ model: 'smart --resume injected' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(writeFileAgentMock).not.toHaveBeenCalled();
    });

    it('rejects invalid schedule values for file agents', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'new prompt', schedule: '1h',
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '1w' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid schedule'),
      });
      expect(writeFileAgentMock).not.toHaveBeenCalled();
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('preserves an existing file-agent schedule when patching model without schedule', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '4h',
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, model: 'smart' };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValueOnce(existingAgent).mockReturnValueOnce(updatedAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ model: 'smart' }),
      });
      const response = await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });

      expect(response.status).toBe(200);
      expect(setFileAgentOverrideMock).toHaveBeenCalledWith('myproj', 'my-agent', expect.objectContaining({
        model: 'smart',
        schedule: undefined,
      }));
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'file:myproj:my-agent', '4h', 'do work', 'myproj', 'my-agent'
      );
      expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('calls installAgentSchedule for file agent with schedule, enabled, and prompt', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '4h',
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'do work', schedule: '4h' }),
      });
      await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'file:myproj:my-agent', '4h', 'do work', 'myproj', 'my-agent'
      );
    });

    it('calls uninstallAgentSchedule for file agent when schedule is cleared', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      parseFileAgentIdMock.mockReturnValueOnce({ project: 'myproj', name: 'my-agent' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValue(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const request = new NextRequest('http://localhost/api/agents/file:myproj:my-agent', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '' }),
      });
      await PATCH(request, { params: Promise.resolve({ agentId: 'file:myproj:my-agent' }) });
      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /agents/{agentId}', () => {
    it('deletes agent by ID', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('deleted');
    });

    it('returns success even if agent does not exist', async () => {
      const request = new NextRequest('http://localhost/api/agents/nonexistent', {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ agentId: 'nonexistent' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('deleted');
    });

    it('agent is gone after delete', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-del',
          name: 'To Delete',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const deleteReq = new NextRequest('http://localhost/api/agents/agent-del', {
        method: 'DELETE',
      });
      await DELETE(deleteReq, { params: Promise.resolve({ agentId: 'agent-del' }) });

      const getResp = await agentGET(
        new NextRequest('http://localhost/api/agents/agent-del'),
        { params: Promise.resolve({ agentId: 'agent-del' }) }
      );
      expect(getResp.status).toBe(404);
    });

    it('calls uninstallAgentSchedule when deleting', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'DELETE',
      });
      await DELETE(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'proj1', 'Agent');
    });
  });

  describe('schedule installation', () => {
    it('calls installAgentSchedule when creating agent with schedule and prompt', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Scheduled Agent',
          project: 'proj1',
          schedule: '1h',
          prompt: 'Do some work',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        data.agent.id,
        '1h',
        'Do some work',
        'proj1',
        'Scheduled Agent'
      );
    });

    it('does not call installAgentSchedule when creating agent with schedule but no prompt', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1h' }),
      });

      await POST(request);
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('does not call installAgentSchedule when creating agent without schedule', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', prompt: 'Do work' }),
      });

      await POST(request);
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('calls installAgentSchedule when creating skills-only agent (no prompt) with schedule', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Skills Agent',
          project: 'proj1',
          schedule: '1h',
          skillIds: ['skill1'],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('does not call installAgentSchedule when creating agent with empty skills, no prompt, and schedule', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1h', skillIds: [] }),
      });

      await POST(request);
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('calls installAgentSchedule when patching schedule on agent with prompt', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'existing prompt',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '2h' }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'agent-123',
        '2h',
        'existing prompt',
        'proj1',
        'Agent'
      );
    });

    it('calls uninstallAgentSchedule when patching schedule to empty', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '' }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'proj1', 'Agent');
    });

    it('calls uninstallAgentSchedule when patching enabled to false', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });

  describe('PATCH /agents/by-name', () => {
    async function seedAgent(db: TestDbHandle['db'], overrides: Partial<typeof schema.agents.$inferInsert> = {}) {
      const now = Date.now() / 1000;
      await db.insert(schema.agents).values({
        id: 'agent-bn',
        name: 'Self',
        project: 'myproj',
        skillIds: '[]',
        model: 'sonnet',
        prompt: 'original prompt',
        schedule: null,

        createdAt: now,
        updatedAt: now,
        ...overrides,
      });
    }

    it('returns 400 when project or name missing', async () => {
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj' }),
      }));
      expect(res.status).toBe(400);
    });

    it('rejects unsafe lookup names by project+name', async () => {
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'bad/name', prompt: 'x' }),
      }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('slashes'),
      });
    });

    it('returns 404 when no agent matches project+name', async () => {
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Nobody' }),
      }));
      expect(res.status).toBe(404);
    });

    it('updates prompt by project+name', async () => {
      await seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'improved prompt' }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prompt).toBe('improved prompt');
    });

    it('looks up DB agents by project+name case-insensitively', async () => {
      await seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'self', prompt: 'improved prompt' }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prompt).toBe('improved prompt');
      expect(data.agent.name).toBe('Self');
    });

    it('renames DB agents with currentName + name', async () => {
      await seedAgent(testDb.db);
      resolveProjectPathMock.mockReturnValue('/path/to/myproj');

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'Renamed', prompt: 'improved prompt' }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.name).toBe('Renamed');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Renamed', expect.anything());
    });

    it('renames file agents with currentName + name', async () => {
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:myproj:Self',
        name: 'Self',
        project: 'myproj',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: 'original prompt',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/myproj/.tamtam/agents/Self.md',
      }]);
      renameFileAgentMock.mockReturnValueOnce({
        id: 'file:myproj:Renamed',
        name: 'Renamed',
        project: 'myproj',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: 'renamed prompt',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/myproj/.tamtam/agents/Renamed.md',
      });

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'Renamed', prompt: 'renamed prompt' }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.name).toBe('Renamed');
      expect(renameFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', 'Renamed', expect.anything());
    });

    it('renames file agents safely when only the case changes', async () => {
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([{
        id: 'file:myproj:Self',
        name: 'Self',
        project: 'myproj',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: 'original prompt',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/myproj/.tamtam/agents/Self.md',
      }]);
      renameFileAgentMock.mockReturnValueOnce({
        id: 'file:myproj:self',
        name: 'self',
        project: 'myproj',
        skillIds: [],
        docPaths: [],
        model: 'normal',
        prompt: 'renamed prompt',
        schedule: null,

        enabled: true,
        provider: null,
        prerequisiteCommand: null,
        createdAt: 0,
        updatedAt: 0,
        source: 'file' as const,
        filePath: '/path/to/myproj/.tamtam/agents/self.md',
      });

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'self', prompt: 'renamed prompt' }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.name).toBe('self');
      expect(renameFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', 'self', expect.anything());
      expect(writeFileAgentMock).not.toHaveBeenCalled();
      expect(deleteFileAgentMock).not.toHaveBeenCalled();
    });

    it('rejects case-only rename conflicts by project+name', async () => {
      await seedAgent(testDb.db);
      await seedAgent(testDb.db, { id: 'agent-other', name: 'Taken' });

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'taken' }),
      }));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('already exists'),
      });
    });

    it('updates prerequisiteCommand by project+name for DB agents', async () => {
      await seedAgent(testDb.db);
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'Self',
          prerequisiteCommand: '  echo ready  ',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBe('echo ready');

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
      expect(row?.prerequisiteCommand).toBe('echo ready');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
        prerequisiteCommand: 'echo ready',
      }));
    });

    it('clears prerequisiteCommand by project+name for DB agents', async () => {
      await seedAgent(testDb.db, { prerequisiteCommand: 'echo ready' });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'Self',
          prerequisiteCommand: '',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBeNull();

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
      expect(row?.prerequisiteCommand).toBe('');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
        prerequisiteCommand: '',
      }));
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank by project+name for DB agents', async () => {
      await seedAgent(testDb.db, {
        skillIds: '["agent-issue-cruncher"]',
        prerequisiteCommand: 'echo ready',
      });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'Self',
          prerequisiteCommand: '',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBeNull();

      const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
      expect(row?.prerequisiteCommand).toBe('');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
        prerequisiteCommand: '',
      }));
    });

    it('updates model by project+name', async () => {
      await seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      const data = await res.json();
      expect(data.agent.model).toBe('smart');
    });

    it('rejects invalid model values by project+name', async () => {
      await seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'smart --resume injected' }),
      }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
    });

    it('rejects invalid schedule values by project+name', async () => {
      await seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', schedule: '1w' }),
      }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid schedule'),
      });
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('normalizes schedule values by project+name before saving and scheduling', async () => {
      await seedAgent(testDb.db, { prompt: 'do work', schedule: null, enabled: true });
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', schedule: ' 2H ' }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.schedule).toBe('2h');
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'agent-bn',
        '2h',
        'do work',
        'myproj',
        'Self'
      );
    });

    it('does not affect an agent with the same name in a different project', async () => {
      const now = Date.now() / 1000;
      await seedAgent(testDb.db);
      await testDb.db.insert(schema.agents).values({ id: 'agent-other', name: 'Self', project: 'other', skillIds: '[]', model: 'haiku', prompt: 'other prompt', schedule: null, createdAt: now, updatedAt: now });

      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'changed' }),
      }));

      const other = (await testDb.db.select().from(schema.agents)).find(a => a.id === 'agent-other');
      expect(other?.prompt).toBe('other prompt');
    });

    it('calls installAgentSchedule when prompt+schedule are set and enabled', async () => {
      await seedAgent(testDb.db, { prompt: 'do work', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'updated work' }),
      }));
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('calls installAgentSchedule for skills-only agent (no prompt) when schedule and enabled', async () => {
      await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('does not call installAgentSchedule when skills-only agent has no schedule', async () => {
      await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: null, enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('calls uninstallAgentSchedule (not install) when agent has empty skills, no prompt, but has schedule', async () => {
      await seedAgent(testDb.db, { prompt: '', skillIds: '[]', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('calls uninstallAgentSchedule (not install) when skills-only agent is disabled', async () => {
      await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: false });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('falls back to file agent when no DB agent matches project+name', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'my-agent', prompt: 'updated' }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.id).toBe('file:myproj:my-agent');
      expect(writeFileAgentMock).toHaveBeenCalledOnce();
    });

    it('updates prerequisiteCommand in by-name file-agent fallback', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        prerequisiteCommand: 'echo old',
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, prerequisiteCommand: 'echo fresh' };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
      writeFileAgentMock.mockReturnValueOnce(updatedAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'my-agent',
          prerequisiteCommand: '  echo fresh  ',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBe('echo fresh');
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: 'updated',
        model: 'sonnet',
        schedule: null,
        skillIds: [],

        enabled: true,
        provider: undefined,
        prerequisiteCommand: 'echo fresh',
      });
    });

    it('clears prerequisiteCommand in by-name file-agent fallback', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        prerequisiteCommand: 'echo old',
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, prerequisiteCommand: null };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
      writeFileAgentMock.mockReturnValueOnce(updatedAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'my-agent',
          prerequisiteCommand: '',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBeNull();
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: 'updated',
        model: 'sonnet',
        schedule: null,
        skillIds: [],

        enabled: true,
        provider: undefined,
        prerequisiteCommand: '',
      });
    });

    it('keeps an explicitly cleared issue-cruncher prerequisite blank in by-name file-agent fallback', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: ['agent-issue-cruncher'] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        prerequisiteCommand: 'echo old',
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, prerequisiteCommand: '' };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
      writeFileAgentMock.mockReturnValueOnce(updatedAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({
          project: 'myproj',
          name: 'my-agent',
          prerequisiteCommand: '',
        }),
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prerequisiteCommand).toBeNull();
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: 'updated',
        model: 'sonnet',
        schedule: null,
        skillIds: ['agent-issue-cruncher'],

        enabled: true,
        provider: undefined,
        prerequisiteCommand: '',
      });
    });

    it('preserves an existing file-agent schedule in by-name fallback when schedule is omitted', async () => {
      const existingAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '2h',
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      const updatedAgent = { ...existingAgent, prompt: 'updated' };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
      writeFileAgentMock.mockReturnValueOnce(updatedAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'my-agent', prompt: 'updated' }),
      }));

      expect(res.status).toBe(200);
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
        prompt: 'updated',
        model: 'sonnet',
        schedule: '2h',
        skillIds: [],

        enabled: true,
        provider: undefined,
        runner: undefined,
        prerequisiteCommand: undefined,
      });
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'file:myproj:my-agent', '2h', 'updated', 'myproj', 'my-agent'
      );
      expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('preserves provider when syncing a DB agent back to the file', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'updated prompt',
          schedule: null,

          enabled: true,
          provider: 'codex',
          createdAt: now,
          updatedAt: now,
        });
      resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'updated prompt' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-123' }),
      });

      expect(response.status).toBe(200);
      expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/proj1', 'proj1', 'Agent', {
        prompt: 'updated prompt',
        model: 'sonnet',
        schedule: null,
        skillIds: [],

        enabled: true,
        provider: 'codex',
        runner: 'pm2',
        prerequisiteCommand: null,
      });
    });

    it('rejects invalid model values for by-name file agent fallback', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'my-agent', model: 'smart --resume injected' }),
      }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(writeFileAgentMock).not.toHaveBeenCalled();
    });

    it('returns 404 when no DB agent and no file agent found', async () => {
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      // scanFileAgents returns [] by default — no file agent either

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'nonexistent' }),
      }));
      expect(res.status).toBe(404);
    });

    it('calls installAgentSchedule for file agent fallback with schedule, prompt, and enabled', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '2h',
 enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'my-agent', schedule: '2h' }),
      }));
      expect(res.status).toBe(200);
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'file:myproj:my-agent', '2h', 'do work', 'myproj', 'my-agent'
      );
    });
  });

    it('calls installAgentSchedule when patching enabled to true on agent with schedule and prompt', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',

          enabled: false,
          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'agent-123',
        '1h',
        'do work',
        'proj1',
        'Agent'
      );
    });

    it('persists enabled field change in database', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      await db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,

          createdAt: now,
          updatedAt: now,
        });

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      const getResp = await agentGET(
        new NextRequest('http://localhost/api/agents/agent-123'),
        { params: Promise.resolve({ agentId: 'agent-123' }) }
      );
      const data = await getResp.json();
      expect(data.agent.enabled).toBe(false);
    });
  });
});
