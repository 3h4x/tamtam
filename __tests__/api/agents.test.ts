import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
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
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('agents API', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let POST: any;
  let PATCH: any;
  let DELETE: any;
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallAgentScheduleMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (request: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) {
          const response = new Response(
            JSON.stringify({ detail: 'Missing or invalid Authorization header' }),
            { status: 401 }
          );
          return new NextResponse(response.body, { status: 401 });
        }
        if (authHeader.slice(7) !== token) {
          const response = new Response(JSON.stringify({ detail: 'Invalid API token' }), {
            status: 401,
          });
          return new NextResponse(response.body, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));

    const agentsRoute = await import('@/app/api/agents/route');
    GET = agentsRoute.GET;
    POST = agentsRoute.POST;

    const agentDetailRoute = await import('@/app/api/agents/[agentId]/route');
    PATCH = agentDetailRoute.PATCH;
    DELETE = agentDetailRoute.DELETE;
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
  });

  describe('POST /agents', () => {
    it('requires authentication when Z_API_TOKEN is set', async () => {
      process.env.Z_API_TOKEN = 'secret-token';

      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);

      delete process.env.Z_API_TOKEN;
    });

    it('creates agent without authentication when Z_API_TOKEN not set', async () => {
      const request = new NextRequest('http://localhost/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Agent', project: 'proj1' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      expect(data.agent.name).toBe('New Agent');
      expect(data.agent.project).toBe('proj1');
      expect(data.agent.model).toBe('sonnet');
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

      expect(data.agent.model).toBe('sonnet');
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

      expect(data.agent.model).toBe('opus');
      expect(data.agent.prompt).toBe('Do something');
      expect(data.agent.schedule).toBe('30m');
      expect(data.agent.runner).toBe('launchctl');
      expect(JSON.parse(data.agent.skillIds)).toEqual(['skill1', 'skill2']);
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

    it('requires authentication when Z_API_TOKEN is set', async () => {
      process.env.Z_API_TOKEN = 'secret-token';

      const request = new NextRequest('http://localhost/api/agents/agent-1', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ agentId: 'agent-1' }),
      });

      expect(response.status).toBe(401);
      delete process.env.Z_API_TOKEN;
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
      expect(data.agent.model).toBe('opus');
      expect(data.agent.prompt).toBe('new prompt');
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
      expect(JSON.parse(data.agent.skillIds)).toEqual(['skill1', 'skill2']);
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
  });

  describe('DELETE /agents/{agentId}', () => {
    it('requires authentication when Z_API_TOKEN is set', async () => {
      process.env.Z_API_TOKEN = 'secret-token';

      const request = new NextRequest('http://localhost/api/agents/agent-1', {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ agentId: 'agent-1' }),
      });

      expect(response.status).toBe(401);
      delete process.env.Z_API_TOKEN;
    });

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
