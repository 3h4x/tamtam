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
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
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
      provider TEXT,
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('skills API', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let skillsGET: any;
  let skillsPOST: any;
  let skillDetailGET: any;
  let skillDetailPATCH: any;
  let skillDetailDELETE: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    const skillsRoute = await import('@/app/api/skills/route');
    skillsGET = skillsRoute.GET;
    skillsPOST = skillsRoute.POST;

    const skillDetailRoute = await import('@/app/api/skills/[skillId]/route');
    skillDetailGET = skillDetailRoute.GET;
    skillDetailPATCH = skillDetailRoute.PATCH;
    skillDetailDELETE = skillDetailRoute.DELETE;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('GET /skills', () => {
    it('returns default agent skills on first call', async () => {
      const response = await skillsGET();
      const data = await response.json();

      expect(data.skills.length).toBeGreaterThan(0);
      expect(data.skills.some((s: any) => s.id === 'agent-cto')).toBe(true);
    });

    it('returns all skills including user-created ones', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-1',
          name: 'Skill 1',
          description: 'First skill',
          content: 'Content 1',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(schema.skills)
        .values({
          id: 'skill-2',
          name: 'Skill 2',
          description: 'Second skill',
          content: 'Content 2',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const response = await skillsGET();
      const data = await response.json();

      const ids = data.skills.map((s: any) => s.id);
      expect(ids).toContain('skill-1');
      expect(ids).toContain('skill-2');
    });

  });

  describe('POST /skills', () => {
    it('creates skill successfully', async () => {
      const request = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Skill' }),
      });

      const response = await skillsPOST(request);
      expect(response.status).toBe(201);
      const data = await response.json();

      expect(data.skill.name).toBe('New Skill');
      expect(data.skill.description).toBe('');
      expect(data.skill.content).toBe('');
    });

    it('validates required name field', async () => {
      const request = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: '' }),
      });

      const response = await skillsPOST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('name is required');
    });

    it('trims whitespace from name', async () => {
      const request = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: '  My Skill  ' }),
      });

      const response = await skillsPOST(request);
      const data = await response.json();

      expect(data.skill.name).toBe('My Skill');
    });

    it('accepts optional description and content', async () => {
      const request = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Skill',
          description: '  A skill description  ',
          content: '# Skill Content\nSome text',
        }),
      });

      const response = await skillsPOST(request);
      const data = await response.json();

      expect(data.skill.description).toBe('A skill description');
      expect(data.skill.content).toBe('# Skill Content\nSome text');
    });

    it('generates unique skill IDs', async () => {
      const req1 = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'Skill 1' }),
      });
      const res1 = await skillsPOST(req1);
      const data1 = await res1.json();

      // Wait to ensure different timestamp
      await new Promise((r) => setTimeout(r, 2));

      const req2 = new NextRequest('http://localhost/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name: 'Skill 2' }),
      });
      const res2 = await skillsPOST(req2);
      const data2 = await res2.json();

      expect(data1.skill.id).not.toBe(data2.skill.id);
    });
  });

  describe('GET /skills/{skillId}', () => {
    it('returns 404 for nonexistent skill', async () => {
      const response = await skillDetailGET(
        new NextRequest('http://localhost/api/skills/nonexistent'),
        { params: Promise.resolve({ skillId: 'nonexistent' }) }
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.detail).toBe('not found');
    });

    it('returns skill by ID', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Test Skill',
          description: 'A test skill',
          content: 'Test content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const response = await skillDetailGET(
        new NextRequest('http://localhost/api/skills/skill-123'),
        { params: Promise.resolve({ skillId: 'skill-123' }) }
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skill.id).toBe('skill-123');
      expect(data.skill.name).toBe('Test Skill');
    });
  });

  describe('PATCH /skills/{skillId}', () => {
    it('returns 404 for nonexistent skill', async () => {
      const request = new NextRequest('http://localhost/api/skills/nonexistent', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await skillDetailPATCH(request, {
        params: Promise.resolve({ skillId: 'nonexistent' }),
      });

      expect(response.status).toBe(404);
    });

    it('updates skill name', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Old Name',
          description: 'Description',
          content: 'Content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/skills/skill-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' }),
      });

      const response = await skillDetailPATCH(request, {
        params: Promise.resolve({ skillId: 'skill-123' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skill.name).toBe('New Name');
    });

    it('updates skill description', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Name',
          description: 'Old description',
          content: 'Content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/skills/skill-123', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'New description' }),
      });

      const response = await skillDetailPATCH(request, {
        params: Promise.resolve({ skillId: 'skill-123' }),
      });

      const data = await response.json();
      expect(data.skill.description).toBe('New description');
    });

    it('updates skill content', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Name',
          description: 'Description',
          content: 'Old content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/skills/skill-123', {
        method: 'PATCH',
        body: JSON.stringify({ content: 'New content' }),
      });

      const response = await skillDetailPATCH(request, {
        params: Promise.resolve({ skillId: 'skill-123' }),
      });

      const data = await response.json();
      expect(data.skill.content).toBe('New content');
    });

    it('updates updatedAt timestamp', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Name',
          description: 'Description',
          content: 'Content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const before = Date.now() / 1000;

      const request = new NextRequest('http://localhost/api/skills/skill-123', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await skillDetailPATCH(request, {
        params: Promise.resolve({ skillId: 'skill-123' }),
      });

      const data = await response.json();
      expect(data.skill.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('DELETE /skills/{skillId}', () => {
    it('deletes skill by ID', async () => {
      const db = testDb.db;
      const now = Date.now() / 1000;
      db.insert(schema.skills)
        .values({
          id: 'skill-123',
          name: 'Name',
          description: 'Description',
          content: 'Content',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const request = new NextRequest('http://localhost/api/skills/skill-123', {
        method: 'DELETE',
      });

      const response = await skillDetailDELETE(request, {
        params: Promise.resolve({ skillId: 'skill-123' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('deleted');
    });

    it('returns success even if skill does not exist', async () => {
      const request = new NextRequest('http://localhost/api/skills/nonexistent', {
        method: 'DELETE',
      });

      const response = await skillDetailDELETE(request, {
        params: Promise.resolve({ skillId: 'nonexistent' }),
      });

      expect(response.status).toBe(200);
    });
  });
});
