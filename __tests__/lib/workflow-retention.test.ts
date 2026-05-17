import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pruneOldWorkflowRuns', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('prunes workflow rows using completed_at without depending on a status column', async () => {
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text.includes('SELECT id FROM workflow.workflow_runs')) {
          return { rows: [{ id: 'run-old' }, { id: 'run-older' }], rowCount: 2 };
        }
        if (text.startsWith('DELETE FROM workflow.workflow_events')) return { rowCount: 4 };
        if (text.startsWith('DELETE FROM workflow.workflow_steps')) return { rowCount: 3 };
        if (text.startsWith('DELETE FROM workflow.workflow_waits')) return { rowCount: 2 };
        if (text.startsWith('DELETE FROM workflow.workflow_hooks')) return { rowCount: 1 };
        if (text.startsWith('DELETE FROM workflow.workflow_stream_chunks')) return { rowCount: 5 };
        if (text.startsWith('DELETE FROM workflow.workflow_runs')) return { rowCount: 2 };
        return { rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
    };

    class FakePool {
      constructor(_opts: unknown) {
        return pool as unknown as FakePool;
      }
    }

    vi.doMock('pg', () => ({
      default: { Pool: FakePool },
      Pool: FakePool,
    }));

    const { pruneOldWorkflowRuns } = await import('@/lib/workflows/cron/workflow-retention');
    const summary = await pruneOldWorkflowRuns({
      retentionDays: 30,
      connectionString: 'postgres://example',
    });

    const selectQuery = queries.find((q) => q.text.includes('SELECT id FROM workflow.workflow_runs'));
    expect(selectQuery?.text).toContain('completed_at IS NOT NULL');
    expect(selectQuery?.text).not.toContain('status IN');
    expect(selectQuery?.params).toHaveLength(1);
    expect(summary).toMatchObject({
      status: 'completed',
      retentionDays: 30,
      runsDeleted: 2,
      eventsDeleted: 4,
      stepsDeleted: 3,
      waitsDeleted: 2,
      hooksDeleted: 1,
      streamChunksDeleted: 5,
      errorCount: 0,
      lastError: null,
    });
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });
});
