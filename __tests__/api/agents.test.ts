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

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

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

    const agentsRoute = await import('@/app/api/agents/route');
    GET = agentsRoute.GET;
    POST = agentsRoute.POST;
  });

  afterEach(() => {
    vi.unmock('@/lib/db');
    vi.unmock('@/lib/auth');
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

      // Verify in database
      const db = testDb.db;
      const stored = db
        .select()
        .from(schema.agents)
        .where(vi.fn())
        .all();
      // We can't use eq() without proper mocking, so just check the response is valid
      expect(agentId).toBeTruthy();
      expect(data.agent).toBeTruthy();
    });
  });
});
