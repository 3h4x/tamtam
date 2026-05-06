import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('POST /api/agents/{agentId}/run runtime DB bootstrap', () => {
  const originalDbPath = process.env.TAMTAM_DB_PATH;

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TAMTAM_DB_PATH;
    else process.env.TAMTAM_DB_PATH = originalDbPath;
    vi.doUnmock('@/lib/pipeline/pipeline-lock');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('queues behind an active release on a freshly bootstrapped runtime db', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-db-'));
    const dbPath = join(tempDir, 'tamtam.db');
    process.env.TAMTAM_DB_PATH = dbPath;
    vi.resetModules();

    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(true),
      getLock: vi.fn().mockReturnValue({ project: 'proj1', lockedByJobId: 'release-1' }),
    }));

    const { db, schema } = await import('@/lib/db');
    db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'Docs',
      project: 'proj1',
      skillIds: '[]',
      model: 'normal',
      prompt: 'Run docs',
      schedule: null,
      runner: 'pm2',
      enabled: true,
      docPaths: '[]',
      provider: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();

    const { POST } = await import('@/app/api/agents/[agentId]/run/route');
    const { listQueuedAgentRunsForProject } = await import('@/lib/agents/queued-agent-runs');

    const req = new NextRequest('http://localhost/api/agents/agent-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-1' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.code).toBe('pipeline_lock');
    expect(listQueuedAgentRunsForProject('proj1')).toEqual([
      expect.objectContaining({
        project: 'proj1',
        agentId: 'agent-1',
        agentName: 'Docs',
        prompt: 'Ship it',
      }),
    ]);

    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const table = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queued_agent_runs'",
      ).get();
      const index = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'queued_agent_runs_project_agent'",
      ).get();
      expect(table).toEqual({ name: 'queued_agent_runs' });
      expect(index).toEqual({ name: 'queued_agent_runs_project_agent' });
    } finally {
      sqlite.close();
    }
  });
});
