import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

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
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
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

describe('applyRecommendation', () => {
  let sharedHandle: TestDbHandle;
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let applyRecommendation: typeof import('@/lib/recommendations/apply-recommendation').applyRecommendation;
  let ApplyRecommendationError: typeof import('@/lib/recommendations/apply-recommendation').ApplyRecommendationError;
  let installAgentScheduleMock: ReturnType<typeof vi.fn>;
  let uninstallAgentScheduleMock: ReturnType<typeof vi.fn>;
  let clearAgentsCacheMock: ReturnType<typeof vi.fn>;
  let normalizeAgentMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
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
    installAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    uninstallAgentScheduleMock = vi.fn().mockResolvedValue(undefined);
    clearAgentsCacheMock = vi.fn();
    normalizeAgentMock = vi.fn((agent) => ({ ...agent, source: 'db' }));

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/scheduling/agent-scheduler', () => ({
      installAgentSchedule: installAgentScheduleMock,
      uninstallAgentSchedule: uninstallAgentScheduleMock,
    }));
    vi.doMock('@/lib/agents/agents-cache', () => ({
      clearAgentsCache: clearAgentsCacheMock,
      normalizeAgent: normalizeAgentMock,
    }));

    ({ applyRecommendation, ApplyRecommendationError } = await import('@/lib/recommendations/apply-recommendation'));
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rejects non-auto-applicable recommendations before mutating agent state', async () => {
    await handle.db.insert(schema.recommendations).values({
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
    });

    await expect(applyRecommendation('portal', 'rec-manual')).rejects.toMatchObject({
      name: 'ApplyRecommendationError',
      status: 400,
      message: 'Recommendation type "note" is not auto-applicable',
    });
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('applies a DB-backed schedule backoff and marks the recommendation applied', async () => {
    await handle.db.insert(schema.agents).values({
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
    await handle.db.insert(schema.recommendations).values({
      id: 'rec-db-success',
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
    });

    const result = await applyRecommendation('portal', 'rec-db-success');

    expect(result.recommendation.status).toBe('applied');
    expect(result.agent).toMatchObject({
      id: 'agent-1',
      project: 'portal',
      schedule: '8h',
      source: 'db',
    });
    const agentRows = await handle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    const recRows = await handle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-db-success'));
    expect(agentRows[0]?.schedule).toBe('8h');
    expect(recRows[0]?.status).toBe('applied');
    expect(installAgentScheduleMock).toHaveBeenCalledWith('agent-1', '8h', 'run tests', 'portal', 'tests');
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    expect(clearAgentsCacheMock).toHaveBeenCalledTimes(1);
    expect(normalizeAgentMock).toHaveBeenCalledTimes(1);
  });

  it('rejects DB-backed system agents without changing their Settings-managed schedule', async () => {
    await handle.db.insert(schema.agents).values({
      id: 'system:portal:documentation-reindex-vectors',
      name: 'documentation-reindex-vectors',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: '',
      schedule: '1h',
      enabled: true,
      kind: 'system',
      createdAt: 100,
      updatedAt: 100,
    });
    await handle.db.insert(schema.recommendations).values({
      id: 'rec-system-agent',
      project: 'portal',
      sourceKind: 'agent:documentation-reindex-vectors',
      agentId: 'system:portal:documentation-reindex-vectors',
      agentName: 'documentation-reindex-vectors',
      type: 'agent_schedule_backoff',
      title: 'Run documentation reindex less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    });

    await expect(applyRecommendation('portal', 'rec-system-agent')).rejects.toMatchObject({
      name: 'ApplyRecommendationError',
      status: 400,
      message: 'System agent schedule is managed by settings',
    });

    const agentRows = await handle.db.select().from(schema.agents).where(eq(schema.agents.id, 'system:portal:documentation-reindex-vectors'));
    const recRows = await handle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-system-agent'));
    expect(agentRows[0]?.schedule).toBe('1h');
    expect(recRows[0]?.status).toBe('open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
    expect(clearAgentsCacheMock).not.toHaveBeenCalled();
  });

  it('uninstalls live schedule state when the DB agent is disabled', async () => {
    await handle.db.insert(schema.agents).values({
      id: 'agent-disabled',
      name: 'tests',
      project: 'portal',
      skillIds: '[]',
      docPaths: '[]',
      model: 'normal',
      prompt: 'run tests',
      schedule: '1h',
      enabled: false,
      createdAt: 100,
      updatedAt: 100,
    });
    await handle.db.insert(schema.recommendations).values({
      id: 'rec-db-disabled',
      project: 'portal',
      sourceKind: 'agent:tests',
      agentId: 'agent-disabled',
      agentName: 'tests',
      type: 'agent_schedule_backoff',
      title: 'Run tests less often',
      detail: 'No actionable work.',
      status: 'open',
      payload: JSON.stringify({ recommendedSchedule: '8h' }),
      createdAt: 100,
      updatedAt: 100,
    });

    const result = await applyRecommendation('portal', 'rec-db-disabled');

    expect(result.recommendation.status).toBe('applied');
    expect(result.agent).toMatchObject({
      id: 'agent-disabled',
      schedule: '8h',
      enabled: false,
      source: 'db',
    });
    const agentRows = await handle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-disabled'));
    const recRows = await handle.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, 'rec-db-disabled'));
    expect(agentRows[0]?.schedule).toBe('8h');
    expect(recRows[0]?.status).toBe('applied');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-disabled', 'portal', 'tests');
  });

  it('rejects invalid recommended schedules before updating the target agent', async () => {
    await handle.db.insert(schema.agents).values({
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
    await handle.db.insert(schema.recommendations).values({
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
    });

    await expect(applyRecommendation('portal', 'rec-invalid-schedule')).rejects.toMatchObject({
      name: 'ApplyRecommendationError',
      status: 400,
      message: expect.stringContaining('Invalid schedule'),
    });

    const agentRows = await handle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    const agent = agentRows[0];
    const recRows = await handle.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.id, 'rec-invalid-schedule'));
    const recommendation = recRows[0];
    expect(agent?.schedule).toBe('1h');
    expect(recommendation?.status).toBe('open');
    expect(installAgentScheduleMock).not.toHaveBeenCalled();
    expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
  });

  it('surfaces rollback failure when live scheduler sync fails twice for a DB agent', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handle.db.insert(schema.agents).values({
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
    await handle.db.insert(schema.recommendations).values({
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
    });
    installAgentScheduleMock
      .mockRejectedValueOnce(new Error('scheduler boom'))
      .mockRejectedValueOnce(new Error('rollback boom'));

    await expect(applyRecommendation('portal', 'rec-rollback-fail')).rejects.toEqual(
      new ApplyRecommendationError(500, 'Failed to update live agent schedule; rollback also failed'),
    );

    const agentRows = await handle.db.select().from(schema.agents).where(eq(schema.agents.id, 'agent-1'));
    const agent = agentRows[0];
    const recRows = await handle.db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.id, 'rec-rollback-fail'));
    const recommendation = recRows[0];
    expect(agent?.schedule).toBe('1h');
    expect(recommendation?.status).toBe('open');
    expect(clearAgentsCacheMock).toHaveBeenCalledTimes(2);
    expect(normalizeAgentMock).not.toHaveBeenCalled();
    expect(installAgentScheduleMock).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

    consoleErrorSpy.mockRestore();
  });
});
