import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
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
      model TEXT NOT NULL DEFAULT 'normal',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT,
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      payload TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('applyRecommendation', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let applyRecommendation: typeof import('@/lib/recommendations/apply-recommendation').applyRecommendation;
  let ApplyRecommendationError: typeof import('@/lib/recommendations/apply-recommendation').ApplyRecommendationError;
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallAgentScheduleMock: ReturnType<typeof vi.fn>;
  let clearAgentsCacheMock: ReturnType<typeof vi.fn>;
  let normalizeAgentMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    clearAgentsCacheMock = vi.fn();
    normalizeAgentMock = vi.fn((agent) => ({ ...agent, source: 'db' }));

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/agents/agents-cache', () => ({
      clearAgentsCache: clearAgentsCacheMock,
      normalizeAgent: normalizeAgentMock,
    }));

    ({ applyRecommendation, ApplyRecommendationError } = await import('@/lib/recommendations/apply-recommendation'));
  });

  it('rejects non-auto-applicable recommendations before mutating agent state', async () => {
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-manual',
      project: 'portal',
      sourceKind: 'agent:tests',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'note',
      title: 'Manual follow-up',
      detail: 'Needs operator review.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();

    await expect(applyRecommendation('portal', 'rec-manual')).rejects.toMatchObject({
      name: 'ApplyRecommendationError',
      status: 400,
      message: 'Recommendation type "note" is not auto-applicable',
    });
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('rejects invalid recommended schedules before updating the target agent', async () => {
    testDb.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      runner: 'pm2',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    }).run();
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-invalid-schedule',
      project: 'portal',
      sourceKind: 'agent:tests',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '1w' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();

    await expect(applyRecommendation('portal', 'rec-invalid-schedule')).rejects.toMatchObject({
      name: 'ApplyRecommendationError',
      status: 400,
      message: expect.stringContaining('Invalid schedule'),
    });

    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1')).get();
    const recommendation = testDb.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.id, 'rec-invalid-schedule'))
      .get();
    expect(agent?.schedule).toBe('1h');
    expect(recommendation?.status).toBe('open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('surfaces rollback failure when live scheduler sync fails twice for a DB agent', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    testDb.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      runner: 'pm2',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    }).run();
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-rollback-fail',
      project: 'portal',
      sourceKind: 'agent:tests',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();
    installAgentScheduleMock
      .mockRejectedValueOnce(new Error('scheduler boom'))
      .mockRejectedValueOnce(new Error('rollback boom'));

    await expect(applyRecommendation('portal', 'rec-rollback-fail')).rejects.toEqual(
      new ApplyRecommendationError(500, 'Failed to update live agent schedule; rollback also failed'),
    );

    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1')).get();
    const recommendation = testDb.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.id, 'rec-rollback-fail'))
      .get();
    expect(agent?.schedule).toBe('1h');
    expect(recommendation?.status).toBe('open');
    expect(clearAgentsCacheMock).toHaveBeenCalledTimes(2);
    expect(normalizeAgentMock).not.toHaveBeenCalled();
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

    consoleErrorSpy.mockRestore();
  });
});
