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
  return await import('@/app/api/workflow-runs/[runId]/route');
}

function makeRequest(url = 'http://test/api/workflow-runs/wrun_1'): Request {
  return new Request(url);
}

function makeParams(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

const RUN_ROW = {
  id: 'wrun_1',
  name: 'workflow//./lib/workflows/release//releaseObservationWorkflow',
  status: 'completed',
  created_at: new Date('2026-05-14T20:00:00Z'),
  started_at: new Date('2026-05-14T20:00:01Z'),
  completed_at: new Date('2026-05-14T20:00:05Z'),
  output: { decision: { next: 'review', from: 'test' } },
  error: null,
};
const STEP_ROW = {
  step_id: 'wstep_1',
  step_name: 'step//./lib/workflows/release//decideNextPhaseStep',
  status: 'completed',
  attempt: 1,
  created_at: new Date('2026-05-14T20:00:02Z'),
  started_at: new Date('2026-05-14T20:00:02Z'),
  completed_at: new Date('2026-05-14T20:00:03Z'),
  input: { jobId: 'test-job-1' },
  output: { next: 'review', from: 'test' },
  error: null,
};

describe('GET /api/workflow-runs/[runId]', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('returns run + steps when found', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock
      .mockResolvedValueOnce({ rows: [RUN_ROW] })  // run query
      .mockResolvedValueOnce({ rows: [STEP_ROW] }); // steps query
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams('wrun_1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({
      id: 'wrun_1',
      name: 'releaseObservationWorkflow',
      status: 'completed',
      durationMs: 4000,
    });
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({
      stepId: 'wstep_1',
      name: 'decideNextPhaseStep',
      status: 'completed',
      attempt: 1,
      durationMs: 1000,
      input: { jobId: 'test-job-1' },
      output: { next: 'review', from: 'test' },
    });
  });

  it('returns 404 when run not found', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams('missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toMatch(/not found/);
  });

  it('returns 503 when WORKFLOW_POSTGRES_URL is unset', async () => {
    delete process.env.WORKFLOW_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams('wrun_1'));
    expect(res.status).toBe(503);
  });

  it('returns 400 when runId is missing', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams(''));
    expect(res.status).toBe(400);
  });

  it('returns 500 with detail on DB error', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock.mockRejectedValue(new Error('relation "workflow.workflow_runs" does not exist'));
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams('wrun_1'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/relation/);
  });

  it('truncates large step input/output payloads', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    const bigPayload = { lines: Array.from({ length: 5000 }, (_, i) => `line ${i}`) };
    const bigStep = { ...STEP_ROW, input: bigPayload, output: bigPayload };
    poolQueryMock
      .mockResolvedValueOnce({ rows: [RUN_ROW] })
      .mockResolvedValueOnce({ rows: [bigStep] });
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), makeParams('wrun_1'));
    const body = await res.json();
    expect(body.steps[0].input).toMatchObject({ _truncated: true });
    expect(body.steps[0].output).toMatchObject({ _truncated: true });
  });

  it('orders steps by created_at then attempt (assertion is delegated to SQL)', async () => {
    // We assert that the steps query includes the ORDER BY clause we rely on.
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock
      .mockResolvedValueOnce({ rows: [RUN_ROW] })
      .mockResolvedValueOnce({ rows: [] });
    const { GET } = await importRoute();
    await GET(makeRequest(), makeParams('wrun_1'));
    const stepsQueryCall = poolQueryMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('workflow_steps'),
    );
    expect(stepsQueryCall).toBeDefined();
    expect(stepsQueryCall![0]).toMatch(/ORDER BY created_at ASC, attempt ASC/);
  });
});
