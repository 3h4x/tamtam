import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class FakePool {
    query = mocks.poolQueryMock;
  },
}));

const poolQueryMock = mocks.poolQueryMock;

async function importRoute() {
  vi.resetModules();
  return await import('@/app/api/workflow-runs/route');
}

function makeRequest(url = 'http://test/api/workflow-runs'): Request {
  return new Request(url);
}

describe('GET /api/workflow-runs', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('returns runs from workflow.workflow_runs', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/tamtam_workflow';
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wrun_1',
          name: 'workflow//./lib/workflows/release//releaseWorkflow',
          status: 'completed',
          created_at: new Date('2026-05-14T20:00:00Z'),
          started_at: new Date('2026-05-14T20:00:01Z'),
          completed_at: new Date('2026-05-14T20:00:02Z'),
          input: ['test-tt', { queueIfBlocked: true }],
          output: { ok: true, step: 'test' },
          error: null,
        },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: 'wrun_1',
      name: 'releaseWorkflow',
      rawName: 'workflow//./lib/workflows/release//releaseWorkflow',
      status: 'completed',
      durationMs: 1000,
      input: ['test-tt', { queueIfBlocked: true }],
      output: { ok: true, step: 'test' },
    });
  });

  it('returns empty runs when WORKFLOW_POSTGRES_URL is unset', async () => {
    delete process.env.WORKFLOW_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toEqual([]);
    expect(body.reason).toMatch(/WORKFLOW_POSTGRES_URL/);
    // meta is included even on the no-pool path so the UI can render
    // its mode badge without a separate request.
    expect(body.meta).toBeDefined();
  });

  it('always reports mode=drive (the observation_only fallback was retired)', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE = '0'; // ignored now
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.meta).toMatchObject({
      releaseWorkflow: true,
      releaseWorkflowDrive: true,
      mode: 'drive',
    });
  });

  it('honors limit query param (capped at 200)', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const { GET } = await importRoute();
    await GET(makeRequest('http://test/api/workflow-runs?limit=500'));
    expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [200]);
  });

  it('defaults limit to 50 when not provided', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const { GET } = await importRoute();
    await GET(makeRequest());
    expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [50]);
  });

  it('truncates large output payloads', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    const bigOutput = { lines: Array.from({ length: 5000 }, (_, i) => `line ${i}`) };
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wrun_big',
          name: 'wf//big',
          status: 'completed',
          created_at: new Date(),
          started_at: new Date(),
          completed_at: new Date(),
          output: bigOutput,
          error: null,
        },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.runs[0].output).toMatchObject({ _truncated: true });
    expect(body.runs[0].output.preview).toBeDefined();
  });

  it('returns 500 on DB error with detail', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock.mockRejectedValueOnce(new Error('relation "workflow.workflow_runs" does not exist'));
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toMatch(/relation/);
  });
});
