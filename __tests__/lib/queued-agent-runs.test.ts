import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE queued_agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      prompt TEXT NOT NULL DEFAULT '',
      enqueued_at REAL NOT NULL,
      UNIQUE(project, agent_id)
    )
  `);
  return db;
}

describe('queued-agent-runs', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let enqueueQueuedAgentRun: typeof import('@/lib/agents/queued-agent-runs').enqueueQueuedAgentRun;
  let listQueuedAgentRunsForProject: typeof import('@/lib/agents/queued-agent-runs').listQueuedAgentRunsForProject;
  let listQueuedAgentRunProjects: typeof import('@/lib/agents/queued-agent-runs').listQueuedAgentRunProjects;
  let removeQueuedAgentRun: typeof import('@/lib/agents/queued-agent-runs').removeQueuedAgentRun;
  let clearQueuedAgentRunsForProject: typeof import('@/lib/agents/queued-agent-runs').clearQueuedAgentRunsForProject;
  let drainQueuedAgentRunsForProject: typeof import('@/lib/agents/queued-agent-runs').drainQueuedAgentRunsForProject;
  let drainQueuedAgentRunsForUnlockedProjects: typeof import('@/lib/agents/queued-agent-runs').drainQueuedAgentRunsForUnlockedProjects;

  beforeEach(async () => {
    testDb = createTestDb();
    vi.resetModules();
    vi.doMock('@/lib/db', () => {
      const { drizzle } = require('drizzle-orm/better-sqlite3');
      const { sqliteTable, text, integer, real, uniqueIndex } = require('drizzle-orm/sqlite-core');
      const queuedAgentRuns = sqliteTable('queued_agent_runs', {
        id: integer('id').primaryKey({ autoIncrement: true }),
        project: text('project').notNull(),
        agentId: text('agent_id').notNull(),
        agentName: text('agent_name').notNull(),
        triggeredBy: text('triggered_by').notNull().default('manual'),
        prompt: text('prompt').notNull().default(''),
        enqueuedAt: real('enqueued_at').notNull(),
      }, (t: { project: unknown; agentId: unknown }) => ({
        projectAgentUniq: uniqueIndex('queued_agent_runs_project_agent').on(t.project, t.agentId),
      }));
      return {
        db: drizzle(testDb),
        schema: { queuedAgentRuns },
      };
    });
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
    }));
    const mod = await import('@/lib/agents/queued-agent-runs');
    enqueueQueuedAgentRun = mod.enqueueQueuedAgentRun;
    listQueuedAgentRunsForProject = mod.listQueuedAgentRunsForProject;
    listQueuedAgentRunProjects = mod.listQueuedAgentRunProjects;
    removeQueuedAgentRun = mod.removeQueuedAgentRun;
    clearQueuedAgentRunsForProject = mod.clearQueuedAgentRunsForProject;
    drainQueuedAgentRunsForProject = mod.drainQueuedAgentRunsForProject;
    drainQueuedAgentRunsForUnlockedProjects = mod.drainQueuedAgentRunsForUnlockedProjects;
  });

  it('enqueues an agent run and lists it', () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'update docs',
      enqueuedAt: 1_000_000,
    });
    const rows = listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe('agent-1');
    expect(rows[0].agentName).toBe('docs');
    expect(rows[0].prompt).toBe('update docs');
    expect(rows[0].triggeredBy).toBe('schedule');
    expect(rows[0].enqueuedAt).toBe(1_000_000); // converted back to ms
  });

  it('is idempotent per project+agentId (upsert updates prompt)', () => {
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'first prompt',
      enqueuedAt: 1_000,
    });
    enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'schedule',
      prompt: 'second prompt',
      enqueuedAt: 2_000,
    });
    const rows = listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('second prompt');
    expect(rows[0].triggeredBy).toBe('schedule');
  });

  it('allows multiple different agents queued for the same project', () => {
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
    const rows = listQueuedAgentRunsForProject('myproject');
    expect(rows).toHaveLength(2);
    expect(rows[0].agentId).toBe('agent-1'); // ordered by enqueuedAt asc
    expect(rows[1].agentId).toBe('agent-2');
  });

  it('lists only entries for the requested project', () => {
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
    expect(listQueuedAgentRunsForProject('project-a')).toHaveLength(1);
    expect(listQueuedAgentRunsForProject('project-b')).toHaveLength(1);
    expect(listQueuedAgentRunsForProject('project-c')).toHaveLength(0);
  });

  it('removeQueuedAgentRun deletes a single entry by id', () => {
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
    const before = listQueuedAgentRunsForProject('myproject');
    removeQueuedAgentRun(before[0].id);
    const after = listQueuedAgentRunsForProject('myproject');
    expect(after).toHaveLength(1);
    expect(after[0].agentId).toBe('agent-2');
  });

  it('clearQueuedAgentRunsForProject removes all entries for the project', () => {
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
    clearQueuedAgentRunsForProject('myproject');
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    expect(listQueuedAgentRunsForProject('other')).toHaveLength(1); // unaffected
  });

  it('returns empty array for a project with no queued runs', () => {
    expect(listQueuedAgentRunsForProject('nonexistent')).toEqual([]);
  });

  it('lists distinct queued projects', () => {
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
    expect(listQueuedAgentRunProjects().sort()).toEqual(['project-a', 'project-b']);
  });

  it('throws when the queue row cannot be persisted', () => {
    testDb.exec('DROP TABLE queued_agent_runs');
    expect(() => enqueueQueuedAgentRun('myproject', {
      project: 'myproject',
      agentId: 'agent-1',
      agentName: 'docs',
      triggeredBy: 'manual',
      prompt: 'run docs',
      enqueuedAt: 1_000,
    })).toThrow();
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 202,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'pipeline_lock',
        detail: 'release pipeline is running',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 202,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'pending_release',
        detail: 'pending release will run first',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'already_running',
        detail: 'Agent is already running',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);

    await drainQueuedAgentRunsForProject('myproject');
    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    const timeoutError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Headers Timeout Error'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[queued-agent-runs] transient timeout draining docs for myproject: fetch failed',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (!fetchControl.resolve) throw new Error('fetch was not started');
    fetchControl.resolve();
    await Promise.all([first, second]);

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'already_starting',
        detail: 'Agent is already starting',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'jobs_paused',
        detail: 'Jobs are paused globally. Turn the switch back on in Settings.',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'project_paused',
        detail: "Project 'myproject' is paused — agent runs are blocked. Resume on the project page to continue.",
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'issue_branch',
        detail: 'Cannot run agent while on an issue branch',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: 'Jobs are paused globally. Turn the switch back on in Settings.',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
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
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[queued-agent-runs] transient timeout draining docs for myproject: The operation was aborted',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'agent_disabled',
        detail: 'Agent is disabled',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        detail: "Selected provider 'claude' is not enabled. Pick another provider or enable it in Settings → CLI.",
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        code: 'no_schedule',
        detail: 'Agent has no schedule',
      })),
    }));

    await drainQueuedAgentRunsForProject('myproject');

    expect(listQueuedAgentRunsForProject('myproject')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('drains queued runs for unlocked projects only', async () => {
    vi.resetModules();
    testDb = createTestDb();
    const getLockMock = vi.fn((project: string) => (project === 'locked' ? { lockedByJobId: 'release-1' } : null));
    vi.doMock('@/lib/db', () => {
      const { drizzle } = require('drizzle-orm/better-sqlite3');
      const { sqliteTable, text, integer, real, uniqueIndex } = require('drizzle-orm/sqlite-core');
      const queuedAgentRuns = sqliteTable('queued_agent_runs', {
        id: integer('id').primaryKey({ autoIncrement: true }),
        project: text('project').notNull(),
        agentId: text('agent_id').notNull(),
        agentName: text('agent_name').notNull(),
        triggeredBy: text('triggered_by').notNull().default('manual'),
        prompt: text('prompt').notNull().default(''),
        enqueuedAt: real('enqueued_at').notNull(),
      }, (t: { project: unknown; agentId: unknown }) => ({
        projectAgentUniq: uniqueIndex('queued_agent_runs_project_agent').on(t.project, t.agentId),
      }));
      return {
        db: drizzle(testDb),
        schema: { queuedAgentRuns },
      };
    });
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: getLockMock,
    }));
    const mod = await import('@/lib/agents/queued-agent-runs');
    enqueueQueuedAgentRun = mod.enqueueQueuedAgentRun;
    listQueuedAgentRunsForProject = mod.listQueuedAgentRunsForProject;
    drainQueuedAgentRunsForUnlockedProjects = mod.drainQueuedAgentRunsForUnlockedProjects;

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(''),
    }));

    await drainQueuedAgentRunsForUnlockedProjects();

    expect(listQueuedAgentRunsForProject('unlocked')).toHaveLength(0);
    expect(listQueuedAgentRunsForProject('locked')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
