import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stringify as devalueStringify } from 'devalue';

const mocks = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  errorListenerCount: 0,
}));

vi.mock('pg', () => ({
  Pool: class FakePool {
    listenerCount = vi.fn((event: string) => event === 'error' ? mocks.errorListenerCount : 0);
    on = vi.fn((event: string, _listener: (err: Error) => void) => {
      if (event === 'error') {
        mocks.errorListenerCount += 1;
      }
      return this;
    });
    query = mocks.poolQueryMock;
  },
}));

const poolQueryMock = mocks.poolQueryMock;

async function importRoute() {
  vi.resetModules();
  return await import('@/app/api/workflow-runs/[runId]/route');
}

async function importListRoute() {
  vi.resetModules();
  return await import('@/app/api/workflow-runs/route');
}

function makeRequest(url = 'http://test/api/workflow-runs/wrun_1'): Request {
  return new Request(url);
}

function makeListRequest(url = 'http://test/api/workflow-runs'): Request {
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
    mocks.errorListenerCount = 0;
    Reflect.deleteProperty(globalThis, '__tamtamWorkflowRunsPool');
    delete process.env.WORKFLOW_TARGET_WORLD;
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
  });

  function localPayload(value: unknown) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(`devl${devalueStringify(value)}`).toString('base64'),
    };
  }

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

  it('returns local-world run details and steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-workflow-detail-'));
    try {
      mkdirSync(join(dir, 'runs'));
      mkdirSync(join(dir, 'steps'));
      writeFileSync(join(dir, 'runs', 'wrun_local.json'), JSON.stringify({
        runId: 'wrun_local',
        workflowName: 'workflow//./lib/workflows/release-orchestrator//releaseOrchestratorWorkflow',
        status: 'completed',
        createdAt: '2026-05-16T11:07:42.279Z',
        startedAt: '2026-05-16T11:07:42.281Z',
        completedAt: '2026-05-16T11:07:42.571Z',
        input: localPayload(['proj', { parentJobId: 'release-1' }]),
        output: localPayload({ dispatch: { phase: 'review' } }),
      }));
      writeFileSync(join(dir, 'steps', 'wrun_local-step_2.json'), JSON.stringify({
        runId: 'wrun_local',
        stepId: 'step_2',
        stepName: 'step//./lib/workflows/phases/review-phase//readReviewVerdictStep',
        status: 'completed',
        attempt: 2,
        createdAt: '2026-05-16T11:07:43.000Z',
        startedAt: '2026-05-16T11:07:43.001Z',
        completedAt: '2026-05-16T11:07:44.001Z',
        input: localPayload({ jobId: 'review-1' }),
        output: localPayload('LGTM'),
      }));
      writeFileSync(join(dir, 'steps', 'wrun_local-step_1.json'), JSON.stringify({
        runId: 'wrun_local',
        stepId: 'step_1',
        stepName: 'step//./lib/workflows/release-orchestrator//waitForJobStep',
        status: 'completed',
        attempt: 1,
        createdAt: '2026-05-16T11:07:42.500Z',
        startedAt: '2026-05-16T11:07:42.501Z',
        completedAt: '2026-05-16T11:07:42.601Z',
        input: localPayload({ jobId: 'test-1' }),
        output: localPayload({ finished: true }),
      }));
      process.env.WORKFLOW_TARGET_WORLD = 'local';
      process.env.WORKFLOW_LOCAL_DATA_DIR = dir;

      const { GET } = await importRoute();
      const res = await GET(makeRequest(), makeParams('wrun_local'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run).toMatchObject({
        id: 'wrun_local',
        name: 'releaseOrchestratorWorkflow',
        input: ['proj', { parentJobId: 'release-1' }],
        output: { dispatch: { phase: 'review' } },
      });
      expect(body.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['step_1', 'step_2']);
      expect(body.steps[1]).toMatchObject({
        name: 'readReviewVerdictStep',
        attempt: 2,
        input: { jobId: 'review-1' },
        output: 'LGTM',
      });
      expect(poolQueryMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('attaches the shared pool error listener when the detail route initializes the pool first', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock
      .mockResolvedValueOnce({ rows: [RUN_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { GET } = await importRoute();
    await GET(makeRequest(), makeParams('wrun_1'));

    const listRoute = await importListRoute();
    await listRoute.GET(makeListRequest());

    expect(mocks.errorListenerCount).toBe(1);
  });
});
