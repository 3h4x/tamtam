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
  return drizzle(sqlite, { schema });
}

const scanFileAgentsMock = vi.fn();
const resolveProjectPathMock = vi.fn();

describe('findAgentNameConflict', () => {
  let db: ReturnType<typeof createTestDb>;
  let findAgentNameConflict: (project: string, name: string, options?: { excludeDbAgentId?: string; excludeFileAgentName?: string }) => import('@/lib/agents/agent-conflicts').AgentNameConflict | null;

  beforeEach(async () => {
    vi.resetModules();
    db = createTestDb();
    scanFileAgentsMock.mockReset();
    resolveProjectPathMock.mockReset();

    vi.doMock('@/lib/db', () => ({ db, schema }));
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
    db.insert(schema.agents).values({
      id,
      name,
      project,
      skillIds: '[]',
      docPaths: '[]',
      model: 'sonnet',
      prompt: '',
      runner: 'pm2',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();
  }

  it('returns null when no DB agent and no file agents match', () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);
    expect(findAgentNameConflict('myproject', 'my-agent')).toBeNull();
  });

  it('detects a DB agent name conflict (exact match)', () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).toEqual({ kind: 'db', name: 'my-agent', agentId: 'agent-1' });
  });

  it('detects a DB agent name conflict case-insensitively', () => {
    insertAgent('agent-2', 'myproject', 'My-Agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).not.toBeNull();
    expect(conflict?.kind).toBe('db');
    expect(conflict?.agentId).toBe('agent-2');
  });

  it('skips DB agent when excludeDbAgentId matches', () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-1' });
    expect(conflict).toBeNull();
  });

  it('does not skip a different DB agent when excludeDbAgentId is set', () => {
    insertAgent('agent-1', 'myproject', 'my-agent');
    insertAgent('agent-2', 'myproject', 'other-agent');
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-2' });
    expect(conflict?.agentId).toBe('agent-1');
  });

  it('detects a file agent name conflict', () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([
      { id: 'file:myproject:docs', name: 'docs', project: 'myproject' },
    ]);

    const conflict = findAgentNameConflict('myproject', 'docs');
    expect(conflict).toEqual({ kind: 'file', name: 'docs', agentId: 'file:myproject:docs' });
  });

  it('skips file agent when excludeFileAgentName matches canonically', () => {
    resolveProjectPathMock.mockReturnValue('/projects/myproject');
    scanFileAgentsMock.mockReturnValue([
      { id: 'file:myproject:Docs', name: 'Docs', project: 'myproject' },
    ]);

    const conflict = findAgentNameConflict('myproject', 'docs', { excludeFileAgentName: 'Docs' });
    expect(conflict).toBeNull();
  });

  it('returns null when resolveProjectPath returns null (skips file scan)', () => {
    insertAgent('agent-x', 'other-project', 'shared-name');
    resolveProjectPathMock.mockReturnValue(null);

    const conflict = findAgentNameConflict('myproject', 'shared-name');
    expect(conflict).toBeNull();
    expect(scanFileAgentsMock).not.toHaveBeenCalled();
  });

  it('only matches agents belonging to the same project', () => {
    insertAgent('agent-a', 'project-a', 'shared-name');
    resolveProjectPathMock.mockReturnValue('/projects/project-b');
    scanFileAgentsMock.mockReturnValue([]);

    const conflict = findAgentNameConflict('project-b', 'shared-name');
    expect(conflict).toBeNull();
  });
});
