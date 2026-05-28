import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

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
      model text NOT NULL DEFAULT 'normal',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      kind text NOT NULL DEFAULT 'user',
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id text PRIMARY KEY,
      project text NOT NULL,
      source_kind text NOT NULL,
      source_id text,
      agent_id text,
      agent_name text,
      type text NOT NULL,
      title text NOT NULL,
      detail text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      payload text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

describe('/api/projects/by-project/[projectName]/recommendations', () => {
  let sharedHandle: TestDbHandle;
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

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw(
      'TRUNCATE agents, recommendations, settings',
    ));
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
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

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('lists project recommendations newest first with parsed payload', async () => {
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });

    const res = await GET(new NextRequest('http://test'), { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].payload.recommendedSchedule).toBe('8h');
  });

  it('updates recommendation status', async () => {
    await sharedHandle.db.insert(schema.recommendations).values({
      id: 'rec-1',
      project: 'portal',
      sourceKind: 'agent:tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      createdAt: 100,
      updatedAt: 100,
    });

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
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-apply' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation.status).toBe('applied');
    expect(data.agent.schedule).toBe('8h');
    const agentRows = await sharedHandle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    expect(agentRows[0]?.schedule).toBe('8h');
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(1);
  });

  it('rejects stale recommendations before mutating the agent', async () => {
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });

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
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });

    const recommendationsMod = await import('@/lib/recommendations/recommendations');
    const originalUpdateIfCurrent = recommendationsMod.updateRecommendationStatusIfCurrent;
    const raceSpy = vi.spyOn(recommendationsMod, 'updateRecommendationStatusIfCurrent').mockImplementation(async (project, id, current, next) => {
      const initial = await originalUpdateIfCurrent(project, id, current, next);
      if (next === 'applied' && initial) {
        await recommendationsMod.updateRecommendationStatus(project, id, 'dismissed');
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
    const agentRows = await sharedHandle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    expect(agentRows[0]?.schedule).toBe('1h');
    const recRows = await sharedHandle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-race'));
    expect(recRows[0]?.status).toBe('dismissed');
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    raceSpy.mockRestore();
  });

  it('fails closed and rolls a DB agent schedule back when scheduler sync throws', async () => {
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });
    installAgentScheduleMock.mockRejectedValueOnce(new Error('scheduler boom'));

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-scheduler-db-fail' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.detail).toContain('Failed to update live agent schedule');
    const agentRows = await sharedHandle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    expect(agentRows[0]?.schedule).toBe('1h');
    const recRows = await sharedHandle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-scheduler-db-fail'));
    expect(recRows[0]?.status).toBe('open');
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
      enabled: true,
      provider: null,
      createdAt: 100,
      updatedAt: 100,
      source: 'file',
      filePath: '/tmp/portal/.tamtam/agents/tests.md',
    };
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });
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
    const recRows = await sharedHandle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-scheduler-file-fail'));
    expect(recRows[0]?.status).toBe('open');
    expect(setFileAgentOverrideMock).toHaveBeenNthCalledWith(1, 'portal', 'tests', { schedule: '8h' });
    expect(setFileAgentOverrideMock).toHaveBeenNthCalledWith(2, 'portal', 'tests', { schedule: '1h' });
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
  });

  it('rejects recommendations whose target agent belongs to a different project', async () => {
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-other',
      name: 'tests',
      project: 'other-project',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
    await sharedHandle.db.insert(schema.recommendations).values({
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
    });

    const req = new NextRequest('http://test', {
      method: 'POST',
      body: JSON.stringify({ id: 'rec-cross-project' }),
    });
    const res = await APPLY(req, { params: Promise.resolve({ projectName: 'portal' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('different project');
    const agentRows = await sharedHandle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-other'));
    expect(agentRows[0]?.schedule).toBe('1h');
    const recRows = await sharedHandle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-cross-project'));
    expect(recRows[0]?.status).toBe('open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });
});
