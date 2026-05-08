import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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

describe('/api/projects/by-project/[projectName]/recommendations', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/recommendations/route').GET;
  let PATCH: typeof import('@/app/api/projects/by-project/[projectName]/recommendations/route').PATCH;
  let APPLY: typeof import('@/app/api/projects/by-project/[projectName]/recommendations/apply/route').POST;
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallAgentScheduleMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let parseFileAgentIdMock: ReturnType<typeof vi.fn>;
  let loadFileAgentMock: ReturnType<typeof vi.fn>;
  let writeFileAgentMock: ReturnType<typeof vi.fn>;
  let setFileAgentOverrideMock: ReturnType<typeof vi.fn>;
  let fileAgentState: Record<string, unknown> | null;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    resolveProjectPathMock = vi.fn().mockReturnValue(null);
    parseFileAgentIdMock = vi.fn().mockReturnValue(null);
    fileAgentState = null;
    loadFileAgentMock = vi.fn().mockImplementation(() => (fileAgentState ? { ...fileAgentState } : null));
    writeFileAgentMock = vi.fn().mockImplementation(() => (fileAgentState ? { ...fileAgentState } : null));
    setFileAgentOverrideMock = vi.fn().mockImplementation((_project: string, _name: string, patch: { schedule?: string | null }) => {
      if (!fileAgentState || patch.schedule === undefined) return;
      fileAgentState = { ...fileAgentState, schedule: patch.schedule };
    });
    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({
      parseFileAgentId: parseFileAgentIdMock,
      loadFileAgent: loadFileAgentMock,
      writeFileAgent: writeFileAgentMock,
    }));
    vi.doMock('@/lib/agents/file-agent-overrides', () => ({
      setFileAgentOverride: setFileAgentOverrideMock,
    }));
    ({ GET, PATCH } = await import('@/app/api/projects/by-project/[projectName]/recommendations/route'));
    ({ POST: APPLY } = await import('@/app/api/projects/by-project/[projectName]/recommendations/apply/route'));
  });

  it('lists project recommendations newest first with parsed payload', async () => {
    testDb.db.insert(schema.recommendations).values({
      id: 'portal:agent_schedule_backoff:agent-1',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 200,
    }).run();

    const res = await GET(new NextRequest('http://test'), { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].payload.recommendedSchedule).toBe('8h');
  });

  it('updates recommendation status', async () => {
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-1',
      project: 'portal',
      sourceKind: 'agent:tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      createdAt: 100,
      updatedAt: 100,
    }).run();

    const req = new NextRequest('http://test', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'rec-1', status: 'dismissed' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation.status).toBe('dismissed');
  });

  it('rejects invalid status updates', async () => {
    const req = new NextRequest('http://test', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'rec-1', status: 'bad' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'portal' }) });
    expect(res.status).toBe(400);
  });

  it('rejects marking a recommendation applied through the generic status PATCH', async () => {
    const req = new NextRequest('http://test', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'rec-1', status: 'applied' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'portal' }) });
    expect(res.status).toBe(400);
  });

  it('applies a recommendation through the dedicated server route', async () => {
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
      id: 'rec-apply',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
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

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-apply' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation.status).toBe('applied');
    expect(data.agent.schedule).toBe('8h');
    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1')).get();
    expect(agent?.schedule).toBe('8h');
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(1);
  });

  it('rejects stale recommendations before mutating the agent', async () => {
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
      id: 'rec-dismissed',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentId: 'agent-1',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'dismissed',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-dismissed' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('must be open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('rolls the agent schedule back if marking the recommendation applied loses the race', async () => {
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
      id: 'rec-race',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
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

    const recommendationsMod = await import('@/lib/recommendations/recommendations');
    const originalUpdateIfCurrent = recommendationsMod.updateRecommendationStatusIfCurrent;
    const raceSpy = vi.spyOn(recommendationsMod, 'updateRecommendationStatusIfCurrent').mockImplementation((project, id, current, next) => {
      const initial = originalUpdateIfCurrent(project, id, current, next);
      if (next === 'applied' && initial) {
        recommendationsMod.updateRecommendationStatus(project, id, 'dismissed');
        return null;
      }
      return initial;
    });

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-race' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('already dismissed');
    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1')).get();
    expect(agent?.schedule).toBe('1h');
    const recommendation = testDb.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-race')).get();
    expect(recommendation?.status).toBe('dismissed');
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    raceSpy.mockRestore();
  });

  it('fails closed and rolls a DB agent schedule back when scheduler sync throws', async () => {
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
      id: 'rec-scheduler-db-fail',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
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
    installAgentScheduleMock.mockRejectedValueOnce(new Error('scheduler boom'));

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-scheduler-db-fail' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.detail).toContain('Failed to update live agent schedule');
    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1')).get();
    expect(agent?.schedule).toBe('1h');
    const recommendation = testDb.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-scheduler-db-fail')).get();
    expect(recommendation?.status).toBe('open');
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed and rolls a file agent schedule back when scheduler sync throws', async () => {
    parseFileAgentIdMock.mockReturnValue({ project: 'portal', name: 'tests' });
    resolveProjectPathMock.mockReturnValue('/tmp/portal');
    fileAgentState = {
      id: 'file:portal:tests',
      name: 'tests',
      project: 'portal',
      skillIds: [],
      docPaths: [],
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      runner: 'pm2',
      enabled: true,
      provider: null,
      createdAt: 100,
      updatedAt: 100,
      source: 'file',
      filePath: '/tmp/portal/.tamtam/agents/tests.md',
    };
    testDb.db.insert(schema.recommendations).values({
      id: 'rec-scheduler-file-fail',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentId: 'file:portal:tests',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();
    installAgentScheduleMock.mockRejectedValueOnce(new Error('scheduler boom'));

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-scheduler-file-fail' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.detail).toContain('Failed to update live agent schedule');
    expect(fileAgentState?.schedule).toBe('1h');
    const recommendation = testDb.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-scheduler-file-fail')).get();
    expect(recommendation?.status).toBe('open');
    expect(setFileAgentOverrideMock).toHaveBeenNthCalledWith(1, 'portal', 'tests', { schedule: '8h' });
    expect(setFileAgentOverrideMock).toHaveBeenNthCalledWith(2, 'portal', 'tests', { schedule: '1h' });
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
  });

  it('rejects recommendations whose target agent belongs to a different project', async () => {
    testDb.db.insert(schema.agents).values({
      id: 'agent-other',
      name: 'tests',
      project: 'other-project',
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
      id: 'rec-cross-project',
      project: 'portal',
      sourceKind: 'agent:tests',
      sourceId: 'job-1',
      agentId: 'agent-other',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    }).run();

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-cross-project' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('different project');
    const agent = testDb.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-other')).get();
    expect(agent?.schedule).toBe('1h');
    const recommendation = testDb.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-cross-project')).get();
    expect(recommendation?.status).toBe('open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });
});
