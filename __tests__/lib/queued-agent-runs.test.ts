import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

// Hoisted bag of shared mock state. All tests use these stable references and
// override behavior per-test via `getLockMock.mockImplementation(...)` etc.
// The hoisted bag is constructed before any vi.mock() factory runs so the
// factory below can capture the fn via the bag.
const mocks = vi.hoisted(() => ({
  getLockMock: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/db', () => ({
  get db() {
    return sharedHandle.db;
  },
  get schema() {
    return schema;
  },
}));

vi.mock('@/lib/pipeline/pipeline-lock', () => ({
  getLock: mocks.getLockMock,
}));

// Top-level static import: now that mocks are installed at module-scope before
// any subject-under-test load, we can import once and avoid the
// vi.resetModules + await import per-test cost.
import {
  enqueueQueuedAgentRun,
  listQueuedAgentRunsForProject,
  listQueuedAgentRunProjects,
  removeQueuedAgentRun,
  clearQueuedAgentRunsForProject,
  drainQueuedAgentRunsForProject,
  drainQueuedAgentRunsForUnlockedProjects,
} from '@/lib/agents/queued-agent-runs';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS queued_agent_runs (
      id serial PRIMARY KEY,
      project text NOT NULL,
      agent_id text NOT NULL,
      agent_name text NOT NULL,
      triggered_by text NOT NULL DEFAULT 'manual',
      prompt text NOT NULL DEFAULT '',
      enqueued_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS queued_agent_runs_project_agent
      ON queued_agent_runs (project, agent_id)
  `));
}

async function flush(): Promise<void> {
  // Drain fire-and-forget inserts/deletes by awaiting a no-op SELECT on the
  // same PGlite instance (queries are serialized). Cheaper than a fixed sleep.
  await sharedHandle.db.execute(sql.raw('SELECT 1'));
}

describe('queued-agent-runs', () => {
  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    try {
      await flush();
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    // Ensure the table exists (one test drops it intentionally).
    await applyDdl(sharedHandle);
    await sharedHandle.db.execute(sql.raw('TRUNCATE queued_agent_runs RESTART IDENTITY'));
    // Reset shared mock state without losing stable references.
    mocks.getLockMock.mockReset();
    mocks.getLockMock.mockReturnValue(null);
  });

  it('enqueues an agent run and lists it', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'update docs',
      enqueuedAt: 1_000_000,
    });
    await flush();
    const rows = await listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe('agent-1');
    expect(rows[0].agentName).toBe('docs');
    expect(rows[0].prompt).toBe('update docs');
    expect(rows[0].triggeredBy).toBe('schedule');
    expect(rows[0].enqueuedAt).toBe(1_000_000); // converted back to ms
  });

  it('is idempotent per project+agentId (upsert updates prompt)', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'first prompt',
      enqueuedAt: 1_000,
    });
    await flush();
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'second prompt',
      enqueuedAt: 2_000,
    });
    await flush();
    const rows = await listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('second prompt');
    expect(rows[0].triggeredBy).toBe('schedule');
  });

  it('allows multiple different agents queued for the same project', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 1_000,
    });
    await flush();
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-2',
      agentName: 'tests',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 2_000,
    });
    await flush();
    const rows = await listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(2);
    expect(rows[0].agentId).toBe('agent-1'); // ordered by enqueuedAt asc
    expect(rows[1].agentId).toBe('agent-2');
  });

  it('lists only entries for the requested project', async () => {
    enqueueQueuedAgentRun('project-a', {
      project: 'project-a',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('project-b', {
      project: 'project-b',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 2_000,
    });
    await flush();
    expect(await listQueuedAgentRunsForProject('project-a')).toHaveLength(1);
    expect(await listQueuedAgentRunsForProject('project-b')).toHaveLength(1);
    expect(await listQueuedAgentRunsForProject('project-c')).toHaveLength(0);
  });

  it('removeQueuedAgentRun deletes a single entry by id', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-2',
      agentName: 'tests',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 2_000,
    });
    await flush();
    const before = await listQueuedAgentRunsForProject('myproject');
    removeQueuedAgentRun(before[0].id);
    await flush();
    const after = await listQueuedAgentRunsForProject('myproject');
    expect(after).toHaveLength(1);
    expect(after[0].agentId).toBe('agent-2');
  });

  it('clearQueuedAgentRunsForProject removes all entries for the project', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('other', {
      project: 'other',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 2_000,
    });
    await flush();
    clearQueuedAgentRunsForProject('myproject');
    await flush();
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    expect(await listQueuedAgentRunsForProject('other')).toHaveLength(1); // unaffected
  });

  it('returns empty array for a project with no queued runs', async () => {
    expect(await listQueuedAgentRunsForProject('nonexistent')).toEqual([]);
  });

  it('lists distinct queued projects', async () => {
    enqueueQueuedAgentRun('project-a', {
      project: 'project-a',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('project-a', {
      project: 'project-a',
      agentId: 'agent-2',
      agentName: 'tests',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 2_000,
    });
    enqueueQueuedAgentRun('project-b', {
      project: 'project-b',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: '',
      enqueuedAt: 3_000,
    });
    await flush();
    expect((await listQueuedAgentRunProjects()).sort()).toEqual(['project-a', 'project-b']);
  });

  it('silently swallows errors when the queue row cannot be persisted (fire-and-forget)', async () => {
    await sharedHandle.db.execute(sql.raw('DROP TABLE queued_agent_runs'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // fire-and-forget: does not throw synchronously
    expect(() => enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    })).not.toThrow();
    await flush();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[queued-agent-runs] enqueue failed:'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('keeps the DB row when the replay route returns 202 pipeline_lock', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 202,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'pipeline_lock',
        detail: 'release pipeline is running',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row when the replay route returns 202 pending_release', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 202,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'pending_release',
        detail: 'pending release will run first',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on a transient 429 and retries successfully later', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          code: 'providers_over_budget',
          detail: 'All enabled CLI providers are over budget.',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(''),
      }));

    await drainQueuedAgentRunsForProject('myproject');
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    await flush();
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 replay blockers', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'already_running',
        detail: 'Agent is already running',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 project_busy and drains it after retrying later', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          code: 'project_busy',
          detail: "Job 'run' is already running for myproject (job run-123)",
          blockingJobId: 'run-123',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(''),
      }));

    await drainQueuedAgentRunsForProject('myproject');
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    await flush();
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on a transient 500 replay failure and drains it after retrying later', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          detail: 'Failed to start: pm2 start failed',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(''),
      }));

    await drainQueuedAgentRunsForProject('myproject');
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    await flush();
    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row when replay times out before headers arrive', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    const timeoutError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Headers Timeout Error'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[queued-agent-runs] transient timeout draining docs for myproject: fetch failed',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('single-flights concurrent drains for the same project', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();

    const fetchControl: { resolve: null | (() => void) } = { resolve: null };
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
      fetchControl.resolve = () => resolve({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(''),
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = drainQueuedAgentRunsForProject('myproject');
    const second = drainQueuedAgentRunsForProject('myproject');
    // Allow async DB SELECT (PGlite) to complete and the fetch call to fire,
    // but not enough for the long-running fetch promise to resolve.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    if (!fetchControl.resolve) throw new Error('fetch was not started');
    fetchControl.resolve();
    await Promise.all([first, second]);
    await flush();

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 already_starting', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'already_starting',
        detail: 'Agent is already starting',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 jobs_paused code', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'jobs_paused',
        detail: 'Jobs are paused globally. Turn the switch back on in Settings.',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 project_paused code', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'project_paused',
        detail: "Project 'myproject' is paused — agent runs are blocked. Resume on the project page to continue.",
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row on transient 409 issue_branch code', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'issue_branch',
        detail: 'Cannot run agent while on an issue branch',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row when 409 detail string includes "Jobs are paused globally" without a code', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: 'Jobs are paused globally. Turn the switch back on in Settings.',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('keeps the DB row when replay throws an AbortError (15s timeout)', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await drainQueuedAgentRunsForProject('myproject');

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[queued-agent-runs] transient timeout draining docs for myproject: The operation was aborted',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('drops the DB row when replay hits a terminal disabled-agent 409', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'agent_disabled',
        detail: 'Agent is disabled',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');
    await flush();

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('drops the DB row when replay hits a strict-provider disabled 409', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: "Selected provider 'claude' is not enabled. Pick another provider or enable it in Settings → CLI.",
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');
    await flush();

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('drops the DB row when replay hits a terminal no-schedule 409', async () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'no_schedule',
        detail: 'Agent has no schedule',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');
    await flush();

    expect(await listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('drains queued runs for unlocked projects only', async () => {
    // Override the shared getLock mock for this test only — `unlocked` returns
    // null (no lock), `locked` returns a lock object.
    mocks.getLockMock.mockImplementation((project: string) =>
      project === 'locked' ? { lockedByJobId: 'release-1' } : null,
    );

    enqueueQueuedAgentRun('unlocked', {
      project: 'unlocked',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('locked', {
      project: 'locked',
      agentId: 'agent-2',
      agentName: 'tests',
      triggeredBy: 'manual',
      prompt: 'run tests',
      enqueuedAt: 2_000,
    });
    await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(''),
    }));

    await drainQueuedAgentRunsForUnlockedProjects();
    await flush();

    expect(await listQueuedAgentRunsForProject('unlocked')).toHaveLength(0);
    expect(await listQueuedAgentRunsForProject('locked')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
