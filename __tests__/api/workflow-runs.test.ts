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
  return await import('@/app/api/workflow-runs/route');
}

async function importDetailRoute() {
  vi.resetModules();
  return await import('@/app/api/workflow-runs/[runId]/route');
}

function makeRequest(url = 'http://test/api/workflow-runs'): Request {
  return new Request(url);
}

function makeDetailRequest(url = 'http://test/api/workflow-runs/wrun_1'): Request {
  return new Request(url);
}

function makeDetailParams(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

describe('GET /api/workflow-runs', () => {
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

  it('normalizes structured workflow errors (jsonb {message, stack}) to a string', async () => {
    // Workflow runtime stores failures in workflow_runs.error as jsonb, so
    // node-pg parses them into JS objects. The route used to ship that
    // straight through, breaking the client's `error.split('\n')` call and
    // crashing the page. The API now flattens both shapes — object with
    // `.message` and legacy plain string — into a string before serving.
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/tamtam_workflow';
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wrun_obj',
          name: 'workflow//./lib/workflows/release//releaseWorkflow',
          status: 'failed',
          created_at: new Date('2026-05-19T08:00:00Z'),
          started_at: new Date('2026-05-19T08:00:01Z'),
          completed_at: new Date('2026-05-19T08:00:05Z'),
          input: [],
          output: null,
          error: { message: 'Step "commitStep" failed after 3 retries', stack: 'ChunkLoadError: …' },
        },
        {
          id: 'wrun_str',
          name: 'workflow//./lib/workflows/release//releaseWorkflow',
          status: 'failed',
          created_at: new Date('2026-05-19T08:01:00Z'),
          started_at: new Date('2026-05-19T08:01:01Z'),
          completed_at: new Date('2026-05-19T08:01:05Z'),
          input: [],
          output: null,
          error: 'plain string error from legacy row',
        },
        {
          id: 'wrun_ok',
          name: 'workflow//./lib/workflows/release//releaseWorkflow',
          status: 'completed',
          created_at: new Date('2026-05-19T08:02:00Z'),
          started_at: new Date('2026-05-19T08:02:01Z'),
          completed_at: new Date('2026-05-19T08:02:02Z'),
          input: [],
          output: { ok: true },
          error: null,
        },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    const body = await res.json();
    const byId = Object.fromEntries(body.runs.map((r: { id: string }) => [r.id, r]));
    expect(byId.wrun_obj.error).toBe('Step "commitStep" failed after 3 retries');
    expect(byId.wrun_str.error).toBe('plain string error from legacy row');
    expect(byId.wrun_ok.error).toBeNull();
  });

  it('returns and decodes local-world run files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-workflow-runs-'));
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
        output: localPayload({ decision: { next: 'review' } }),
      }));
      process.env.WORKFLOW_TARGET_WORLD = 'local';
      process.env.WORKFLOW_LOCAL_DATA_DIR = dir;

      const { GET } = await importRoute();
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0]).toMatchObject({
        id: 'wrun_local',
        name: 'releaseOrchestratorWorkflow',
        input: ['proj', { parentJobId: 'release-1' }],
        output: { decision: { next: 'review' } },
      });
      expect(poolQueryMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('attaches the shared pool error listener when the list route initializes the pool first', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://test/wf';
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'wrun_1',
          name: 'workflow//./lib/workflows/release//releaseObservationWorkflow',
          status: 'completed',
          created_at: new Date('2026-05-14T20:00:00Z'),
          started_at: null,
          completed_at: null,
          input: null,
          input_cbor: null,
          output: null,
          output_cbor: null,
          error: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { GET } = await importRoute();
    await GET(makeRequest());

    const detailRoute = await importDetailRoute();
    await detailRoute.GET(makeDetailRequest(), makeDetailParams('wrun_1'));

    expect(mocks.errorListenerCount).toBe(1);
  });
});
