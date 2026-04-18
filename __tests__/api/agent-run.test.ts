import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-job-id',
    project: 'proj1',
    kind: 'agent:Test Agent',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/agents/{agentId}/run', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let tempSkillsDir: string;

  const now = Date.now() / 1000;

  function insertAgent(overrides: Record<string, unknown> = {}) {
    testDb.db
      .insert(schema.agents)
      .values({
        id: 'agent-123',
        name: 'Test Agent',
        project: 'proj1',
        skillIds: '[]',
        model: 'sonnet',
        prompt: '',
        schedule: null,
        runner: 'pm2',
        createdAt: now,
        updatedAt: now,
        ...overrides,
      })
      .run();
  }

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    tempSkillsDir = mkdtempSync(join(tmpdir(), 'tamtam-agent-run-test-'));

    startJobMock = vi.fn().mockResolvedValue(12345);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (request: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp/logs' }),
    }));

    vi.doMock('@/lib/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));

    vi.doMock('@/lib/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/skills', () => ({ SKILLS_DIR: tempSkillsDir, DATA_SKILLS_DIR: join(tempSkillsDir, 'data-skills') }));

    vi.doMock('@/lib/config', () => ({
      withBasePrompt: (p: string) => p,
      getPermissionModeFlag: () => '--dangerously-skip-permissions',
      getSettings: () => ({
        workspace_path: '', github_owner: '', claude_bin: 'claude', log_dir: '/tmp/logs',
        frequency: '1h', daytime: false, weekends: false, launchagent_prefix: 'com.tamtam', base_prompt: '',
        permission_mode: 'bypassPermissions',
      }),
    }));

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  it('returns 404 if agent not found', async () => {
    const req = new NextRequest('http://localhost/api/agents/nonexistent/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('agent not found');
  });

  it('returns 400 if prompt is missing', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('prompt');
  });

  it('returns 400 if prompt is whitespace only', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: '   ' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 if project path cannot be resolved', async () => {
    insertAgent();
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('proj1');
  });

  it('starts job and returns job info', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.agent).toBe('Test Agent');
  });

  it('calls startJob with correct args', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, cmd, fullPrompt, projPath] = startJobMock.mock.calls[0];
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--model sonnet');
    expect(fullPrompt).toContain('run tests');
    expect(projPath).toBe('/path/to/proj');
  });

  it('calls updateJob after startJob', async () => {
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(updateJobMock).toHaveBeenCalledOnce();
  });

  it('composes skills into system prompt', async () => {
    testDb.db
      .insert(schema.skills)
      .values({
        id: 'skill-1',
        name: 'My Skill',
        description: 'desc',
        content: 'Skill instructions here',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertAgent({ skillIds: '["skill-1"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('## My Skill');
    expect(fullPrompt).toContain('Skill instructions here');
    expect(fullPrompt).toContain('task prompt');
  });

  it('does not prepend skill content when agent has no skills', async () => {
    insertAgent({ skillIds: '[]' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task prompt' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toBe('task prompt');
  });

  it('returns 500 if startJob throws', async () => {
    insertAgent();
    startJobMock.mockRejectedValue(new Error('pm2 not available'));
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'do something' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 not available');
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(401);
  });

  it('passes auth with correct Bearer token', async () => {
    process.env.Z_API_TOKEN = 'my-token';
    insertAgent();
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
      headers: { Authorization: 'Bearer my-token' },
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);
  });

  it('prepends file-based persona content when skillIds contains persona:<path>', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), 'FULLSTACK-PERSONA-BODY');

    insertAgent({ skillIds: '["persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'build it' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('FULLSTACK-PERSONA-BODY');
    expect(fullPrompt).toContain('build it');
  });

  it('mixes DB skills and file-based personas in skillIds', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'reviewer.md'), 'REVIEWER-FILE-CONTENT');

    testDb.db
      .insert(schema.skills)
      .values({ id: 'skill-1', name: 'DB Skill', description: '', content: 'DB-SKILL-BODY', createdAt: now, updatedAt: now })
      .run();
    insertAgent({ skillIds: '["skill-1","persona:reviewer"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toContain('DB-SKILL-BODY');
    expect(fullPrompt).toContain('REVIEWER-FILE-CONTENT');
    expect(fullPrompt).toContain('task');
  });

  it('records resolved skills in contextMeta so the terminal toolbar can show chips', async () => {
    const docsDir = join(tempSkillsDir, 'docs', 'skills', 'engineering-team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'senior-fullstack.md'), '---\nname: Senior Fullstack\n---\nbody');

    testDb.db
      .insert(schema.skills)
      .values({ id: 'skill-db', name: 'DB One', description: 'desc', content: 'x', createdAt: now, updatedAt: now })
      .run();
    insertAgent({ skillIds: '["skill-db","persona:engineering-team/senior-fullstack"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    // createJob is called as createJob(project, kind, pid, logPath, prompt, contextMeta, userPrompt)
    const createArgs = createJobMock.mock.calls[0];
    const contextMeta = createArgs[5];
    expect(contextMeta).toBeTruthy();
    const meta = JSON.parse(contextMeta);
    expect(meta.skills).toHaveLength(2);
    const dbChip = meta.skills.find((s: any) => s.source === 'db');
    const fileChip = meta.skills.find((s: any) => s.source === 'file');
    expect(dbChip?.name).toBe('DB One');
    expect(fileChip?.id).toBe('persona:engineering-team/senior-fullstack');
    expect(fileChip?.name).toBe('Senior Fullstack');
  });

  it('silently skips persona paths whose file does not exist', async () => {
    insertAgent({ skillIds: '["persona:nonexistent/missing"]' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'task' }),
    });
    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
    expect(res.status).toBe(200);

    const [, , fullPrompt] = startJobMock.mock.calls[0];
    expect(fullPrompt).toBe('task');
  });
});
