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
      doc_paths TEXT NOT NULL DEFAULT '[]',
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

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude', logDir: '/tmp/logs' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));

    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/skills/skills', () => ({ SKILLS_DIR: tempSkillsDir, DATA_SKILLS_DIR: join(tempSkillsDir, 'data-skills') }));

    vi.doMock('@/lib/agents/agent-memory', () => ({
      getAgentMemoryDir: vi.fn().mockReturnValue('/tmp/tamtam-memory'),
      ensureAgentMemoryDir: vi.fn(),
      getAgentMemoryPath: vi.fn().mockReturnValue('/tmp/tamtam-memory/proj1/Test Agent.md'),
      readAgentMemory: vi.fn().mockReturnValue(null),
      buildMemoryBlock: vi.fn().mockReturnValue(''),
    }));

    vi.doMock('@/lib/shared/config', () => ({
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
    expect(cmd).toContain('--model normal');
    expect(fullPrompt).toContain('run tests');
    expect(projPath).toBe('/path/to/proj');
  });

  it('sanitizes an invalid stored model before building the command', async () => {
    insertAgent({ model: 'smart --resume injected' });
    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'run tests' }),
    });

    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--model normal');
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('injected');
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
    expect(fullPrompt).toContain('task prompt');
    expect(fullPrompt).not.toContain('## My Skill');
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
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
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

  it('records the trigger source in contextMeta for the report finalizer', async () => {
    insertAgent({ schedule: '2h' });

    const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
      method: 'POST',
      headers: { 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: 'task' }),
    });
    await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

    const createArgs = createJobMock.mock.calls[0];
    const contextMeta = JSON.parse(createArgs[5]);
    expect(contextMeta.agent.triggeredBy).toBe('schedule');
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
    expect(fullPrompt).toContain('task');
    expect(fullPrompt).not.toContain('nonexistent');
  });

  describe('doc_paths', () => {
    it('prepends doc file content before skills in the prompt', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        writeFileSync(join(projDir, 'NOTES.md'), 'PROJECT NOTES CONTENT');
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["NOTES.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const [, , fullPrompt] = startJobMock.mock.calls[0];
        expect(fullPrompt).toContain('PROJECT NOTES CONTENT');
        expect(fullPrompt).toContain('## NOTES.md');
        // doc content must appear before the task prompt
        expect(fullPrompt.indexOf('PROJECT NOTES CONTENT')).toBeLessThan(fullPrompt.indexOf('do task'));
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('silently skips doc paths whose file does not exist', async () => {
      insertAgent({ docPaths: '["nonexistent.md"]' });

      const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'do task' }),
      });
      const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(res.status).toBe(200);

      const [, , fullPrompt] = startJobMock.mock.calls[0];
      expect(fullPrompt).toContain('do task');
      expect(fullPrompt).not.toContain('nonexistent');
    });

    it('blocks path traversal outside the project root', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["../../../etc/passwd"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'do task' }),
        });
        const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });
        expect(res.status).toBe(200);

        const [, , fullPrompt] = startJobMock.mock.calls[0];
        // traversal path is blocked — no /etc/passwd content should appear
        expect(fullPrompt).not.toContain('root:');
        expect(fullPrompt).not.toContain('etc/passwd');
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });

    it('records resolved docs in contextMeta', async () => {
      const projDir = mkdtempSync(join(tmpdir(), 'tamtam-docpath-'));
      try {
        writeFileSync(join(projDir, 'GUIDE.md'), 'guide content');
        resolveProjectPathMock.mockReturnValue(projDir);
        insertAgent({ docPaths: '["GUIDE.md"]' });

        const req = new NextRequest('http://localhost/api/agents/agent-123/run', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'task' }),
        });
        await POST(req, { params: Promise.resolve({ agentId: 'agent-123' }) });

        const createArgs = createJobMock.mock.calls[0];
        const contextMeta = JSON.parse(createArgs[5]);
        expect(contextMeta.docs).toHaveLength(1);
        expect(contextMeta.docs[0].name).toBe('GUIDE.md');
        expect(contextMeta.docs[0].path).toBe('GUIDE.md');
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
    });
  });
});
