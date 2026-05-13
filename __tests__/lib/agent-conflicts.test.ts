import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
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
      provider TEXT,
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const scanFileAgentsMock = vi.fn();
const resolveProjectPathMock = vi.fn();

describe('findAgentNameConflict', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let findAgentNameConflict: (project: string, name: string, options?: { excludeDbAgentId?: string; excludeFileAgentName?: string }) => Promise<import('@/lib/agents/agent-conflicts').AgentNameConflict | null>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    scanFileAgentsMock.mockReset();
    resolveProjectPathMock.mockReset();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({
      scanFileAgents: scanFileAgentsMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    const mod = await import('@/lib/agents/agent-conflicts');
    findAgentNameConflict = mod.findAgentNameConflict;
  });

  function insertAgent(id: string, project: string, name: string) {
    testDb.sqlite.prepare(`
      INSERT INTO agents (id, name, project, skill_ids, doc_paths, model, prompt, runner, enabled, created_at, updated_at)
      VALUES (?, ?, ?, '[]', '[]', 'sonnet', '', 'pm2', 1, ?, ?)
    `).run(id, name, project, Date.now(), Date.now());
  }

  it('returns null when no DB agent and no file agents match', async () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);
    expect(await findAgentNameConflict('myproject', 'my-agent')).toBeNull();
  });

  it('detects a DB agent name conflict (exact match)', async () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = await findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).toEqual({ kind: 'db', name: 'my-agent', agentId: 'agent-1' });
  });

  it('detects a DB agent name conflict case-insensitively', async () => {
    insertAgent('agent-2', 'myproject', 'My-Agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = await findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).not.toBeNull();
    expect(conflict?.kind).toBe('db');
    expect(conflict?.agentId).toBe('agent-2');
  });

  it('skips DB agent when excludeDbAgentId matches', async () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = await findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-1' });
    expect(conflict).toBeNull();
  });

  it('does not skip a different DB agent when excludeDbAgentId is set', async () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    insertAgent('agent-2', 'myproject', 'other-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = await findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-2' });
    expect(conflict?.agentId).toBe('agent-1');
  });

  it('detects a file agent name conflict', async () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([
      { id: 'file:myproject:docs', name: 'docs', project: 'myproject' },
    ]);

    const conflict = await findAgentNameConflict('myproject', 'docs');
    expect(conflict).toEqual({ kind: 'file', name: 'docs', agentId: 'file:myproject:docs' });
  });

  it('skips file agent when excludeFileAgentName matches canonically', async () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([
      { id: 'file:myproject:Docs', name: 'Docs', project: 'myproject' },
    ]);

    const conflict = await findAgentNameConflict('myproject', 'docs', { excludeFileAgentName: 'Docs' });
    expect(conflict).toBeNull();
  });

  it('returns null when resolveProjectPath returns null (skips file scan)', async () => {
    insertAgent('agent-x', 'other-project', 'shared-name');
    resolveProjectPathMock.mockReturnValue(null);

    const conflict = await findAgentNameConflict('myproject', 'shared-name');
    expect(conflict).toBeNull();
    expect(scanFileAgentsMock).not.toHaveBeenCalled();
  });

  it('only matches agents belonging to the same project', async () => {
    insertAgent('agent-a', 'project-a', 'shared-name');
    resolveProjectPathMock.mockReturnValue('/projects/project-b');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = await findAgentNameConflict('project-b', 'shared-name');
    expect(conflict).toBeNull();
  });
});
