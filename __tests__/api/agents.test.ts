import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      doc_paths TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
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
      release_after_run INTEGER DEFAULT 0,
      pr_workflow_enabled INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('agents API', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let POST: any;
  let PATCH: any;
  let PATCH_BY_NAME: any;
  let DELETE: any;
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallAgentScheduleMock: ReturnType<typeof vi.fn>;
  let parseFileAgentIdMock: ReturnType<typeof vi.fn>;
  let loadFileAgentMock: ReturnType<typeof vi.fn>;
  let writeFileAgentMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
      clearProjectDataCache: vi.fn(),
      getEnabledProjects: vi.fn().mockReturnValue({}),
    }));

    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({
      scanFileAgents: vi.fn().mockReturnValue([]),
      loadFileAgent: vi.fn().mockReturnValue(null),
      parseFileAgentId: vi.fn().mockReturnValue(null),
      writeFileAgent: vi.fn().mockReturnValue(null),
      deleteFileAgent: vi.fn(),
    }));
    vi.doMock('@/lib/agents/file-agent-overrides', () => ({
      getFileAgentOverride: vi.fn().mockReturnValue(null),
      setFileAgentOverride: vi.fn().mockImplementation((_p: string, _n: string, patch) => patch),
      deleteFileAgentOverride: vi.fn(),
    }));

    // Capture mock function references so individual tests can override return values
    const fileAgentsMod = await import('@/lib/agents/tamtam-file-agents');
    parseFileAgentIdMock = fileAgentsMod.parseFileAgentId as ReturnType<typeof vi.fn>;
    loadFileAgentMock = fileAgentsMod.loadFileAgent as ReturnType<typeof vi.fn>;
    writeFileAgentMock = fileAgentsMod.writeFileAgent as ReturnType<typeof vi.fn>;
    const projectDataMod = await import('@/lib/shared/project-data');
    resolveProjectPathMock = projectDataMod.resolveProjectPath as ReturnType<typeof vi.fn>;

    const agentsRoute = await import('@/app/api/agents/route');
    GET = agentsRoute.GET;
    POST = agentsRoute.POST;

    const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
    PATCH = agentDetailRoute.PATCH;
    DELETE = agentDetailRoute.DELETE;

    const byNameRoute = await import('@/app/api/agents/by-name/route');
    PATCH_BY_NAME = byNameRoute.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

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
      db.insert(schema.agents)
        .values({
          id: 'agent-1',
          name: 'Agent 1',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(schema.agents)
        .values({
          id: 'agent-2',
          name: 'Agent 2',
          project: 'proj2',
          skillIds: '["skill1"]',
          model: 'opus',
          prompt: 'Do something',
          schedule: '1h',
          runner: 'launchctl',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, runner: 'pm2', createdAt: now, updatedAt: now }).run();
      db.insert(schema.agents).values({ id: 'agent-2', name: 'Beta', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, runner: 'pm2', createdAt: now, updatedAt: now }).run();

      const request = new NextRequest('http://localhost/api/agents?name=Alpha');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('filters agents by project and name', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, runner: 'pm2', createdAt: now, updatedAt: now }).run();
      db.insert(schema.agents).values({ id: 'agent-2', name: 'Alpha', project: 'proj2', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, runner: 'pm2', createdAt: now, updatedAt: now }).run();

      const request = new NextRequest('http://localhost/api/agents?project=proj1&name=Alpha');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('filters agents by project', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-1',
          name: 'Agent 1',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(schema.agents)
        .values({
          id: 'agent-2',
          name: 'Agent 2',
          project: 'proj2',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/agents?project=proj1');
      const response = await GET(request);
      const data = await response.json();

      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('agent-1');
    });

    it('merges file agents from all enabled projects on unfiltered GET', async () => {
      const db = testDb.db;
      db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true }).run();
      db.insert(schema.projects).values({ name: 'proj2', path: '/p2', enabled: true }).run();
      db.insert(schema.projects).values({ name: 'projDisabled', path: '/pd', enabled: false }).run();

      const fileAgentsMod = await import('@/lib/agents/tamtam-file-agents');
      const scanMock = fileAgentsMod.scanFileAgents as ReturnType<typeof vi.fn>;
      scanMock.mockImplementation((path: string, project: string) => {
        if (project === 'proj1') {
          return [{
            id: 'file:proj1:fa1', name: 'fa1', project: 'proj1',
            skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
            runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
            source: 'file', filePath: `${path}/.tamtam/agents/fa1.md`,
          }];
        }
        if (project === 'proj2') {
          return [{
            id: 'file:proj2:fa2', name: 'fa2', project: 'proj2',
            skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
            runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
            source: 'file', filePath: `${path}/.tamtam/agents/fa2.md`,
          }];
        }
        return [];
      });

      const response = await GET(new NextRequest('http://localhost/api/agents'));
      const data = await response.json();

      const ids = data.agents.map((a: { id: string }) => a.id).sort();
      expect(ids).toEqual(['file:proj1:fa1', 'file:proj2:fa2']);
      // Disabled project must not be scanned
      const calledProjects = scanMock.mock.calls.map(c => c[1]);
      expect(calledProjects).not.toContain('projDisabled');
    });

    it('DB agent takes precedence over file agent with same project+name on unfiltered GET', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true }).run();
      db.insert(schema.agents).values({
        id: 'db-1', name: 'shared', project: 'proj1', skillIds: '[]',
        model: 'sonnet', prompt: 'db version', schedule: null, runner: 'pm2',
        createdAt: now, updatedAt: now,
      }).run();

      const fileAgentsMod = await import('@/lib/agents/tamtam-file-agents');
      const scanMock = fileAgentsMod.scanFileAgents as ReturnType<typeof vi.fn>;
      scanMock.mockReturnValue([{
        id: 'file:proj1:shared', name: 'shared', project: 'proj1',
        skillIds: [], docPaths: [], model: 'sonnet', prompt: 'file version', schedule: null,
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file', filePath: '/p1/.tamtam/agents/shared.md',
      }]);

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
      expect(data.agent.runner).toBe('pm2');
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

    it('uses default model and runner if not provided', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.model).toBe('normal');
      expect(data.agent.runner).toBe('pm2');
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
          runner: 'launchctl',
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.agent.model).toBe('smart');
      expect(data.agent.prompt).toBe('Do something');
      expect(data.agent.schedule).toBe('30m');
      expect(data.agent.runner).toBe('launchctl');
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
  });

  describe('GET /agents/{agentId}', () => {
    it('returns 404 for nonexistent agent', async () => {
      const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
      const agentGET = agentDetailRoute.GET;

      const response = await agentGET(
        new NextRequest('http://localhost/api/agents/nonexistent'),
        { params: Promise.resolve({ agentId: 'nonexistent' }) }
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.detail).toBe('not found');
    });

    it('returns agent by ID', async () => {
      const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
      const agentGET = agentDetailRoute.GET;
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Test Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'Do stuff',
          schedule: '1h',
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Old Name',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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

    it('updates agent model and prompt', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'old prompt',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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

    it('rejects invalid model values on update', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'old prompt',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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

    it('updates skillIds as JSON array', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do things',
          schedule: '1h',
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: oldTime,
          updatedAt: oldTime,
        })
        .run();

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
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
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
      expect(writeFileAgentMock).toHaveBeenCalledOnce();
    });

    it('rejects invalid model values for file agents', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'new prompt', schedule: null,
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
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

    it('calls installAgentSchedule for file agent with schedule, enabled, and prompt', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '4h',
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
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
        'file:myproj:my-agent', '4h', 'do work', 'pm2', 'myproj', 'my-agent'
      );
    });

    it('calls uninstallAgentSchedule for file agent when schedule is cleared', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: null,
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
      const agentGET = agentDetailRoute.GET;
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-del',
          name: 'To Delete',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'DELETE',
      });
      await DELETE(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'pm2', 'proj1', 'Agent');
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
        'pm2',
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
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'existing prompt',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
        'pm2',
        'proj1',
        'Agent'
      );
    });

    it('calls uninstallAgentSchedule when patching schedule to empty', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ schedule: '' }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'pm2', 'proj1', 'Agent');
    });

    it('calls uninstallAgentSchedule when patching enabled to false', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      });

      await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });

      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });

  describe('PATCH /agents/by-name', () => {
    function seedAgent(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.agents.$inferInsert> = {}) {
      const now = Date.now() / 1000;
      db.insert(schema.agents).values({
        id: 'agent-bn',
        name: 'Self',
        project: 'myproj',
        skillIds: '[]',
        model: 'sonnet',
        prompt: 'original prompt',
        schedule: null,
        runner: 'pm2',
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }).run();
    }

    it('returns 400 when project or name missing', async () => {
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj' }),
      }));
      expect(res.status).toBe(400);
    });

    it('returns 404 when no agent matches project+name', async () => {
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Nobody' }),
      }));
      expect(res.status).toBe(404);
    });

    it('updates prompt by project+name', async () => {
      seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'improved prompt' }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agent.prompt).toBe('improved prompt');
    });

    it('updates model by project+name', async () => {
      seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      const data = await res.json();
      expect(data.agent.model).toBe('smart');
    });

    it('rejects invalid model values by project+name', async () => {
      seedAgent(testDb.db);
      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'smart --resume injected' }),
      }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
    });

    it('does not affect an agent with the same name in a different project', async () => {
      const now = Date.now() / 1000;
      seedAgent(testDb.db);
      testDb.db.insert(schema.agents).values({ id: 'agent-other', name: 'Self', project: 'other', skillIds: '[]', model: 'haiku', prompt: 'other prompt', schedule: null, runner: 'pm2', createdAt: now, updatedAt: now }).run();

      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'changed' }),
      }));

      const other = testDb.db.select().from(schema.agents).all().find(a => a.id === 'agent-other');
      expect(other?.prompt).toBe('other prompt');
    });

    it('calls installAgentSchedule when prompt+schedule are set and enabled', async () => {
      seedAgent(testDb.db, { prompt: 'do work', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'updated work' }),
      }));
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('calls installAgentSchedule for skills-only agent (no prompt) when schedule and enabled', async () => {
      seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('does not call installAgentSchedule when skills-only agent has no schedule', async () => {
      seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: null, enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
    });

    it('calls uninstallAgentSchedule (not install) when agent has empty skills, no prompt, but has schedule', async () => {
      seedAgent(testDb.db, { prompt: '', skillIds: '[]', schedule: '1h', enabled: true });
      await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
      }));
      expect(installAgentScheduleMock).not.toHaveBeenCalled();
      expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('calls uninstallAgentSchedule (not install) when skills-only agent is disabled', async () => {
      seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: false });
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
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValueOnce(fakeAgent);
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

    it('rejects invalid model values for by-name file agent fallback', async () => {
      const fakeAgent = {
        id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
        skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValueOnce(fakeAgent);

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
      // loadFileAgent returns null by default — no file agent either

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
        runner: 'pm2', enabled: true, createdAt: 0, updatedAt: 0,
        source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
      };
      resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
      loadFileAgentMock.mockReturnValueOnce(fakeAgent);
      writeFileAgentMock.mockReturnValueOnce(fakeAgent);

      const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
        method: 'PATCH',
        body: JSON.stringify({ project: 'myproj', name: 'my-agent', schedule: '2h' }),
      }));
      expect(res.status).toBe(200);
      expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      expect(installAgentScheduleMock).toHaveBeenCalledWith(
        'file:myproj:my-agent', '2h', 'do work', 'pm2', 'myproj', 'my-agent'
      );
    });
  });

    it('calls installAgentSchedule when patching enabled to true on agent with schedule and prompt', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'do work',
          schedule: '1h',
          runner: 'pm2',
          enabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
        'pm2',
        'proj1',
        'Agent'
      );
    });

    it('persists enabled field change in database', async () => {
      const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
      const agentGET = agentDetailRoute.GET;
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.agents)
        .values({
          id: 'agent-123',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'sonnet',
          prompt: '',
          schedule: null,
          runner: 'pm2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

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
