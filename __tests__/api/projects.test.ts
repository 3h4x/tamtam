import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── GET /api/projects ────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  let GET: any;
  let fetchProjectDataMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    fetchProjectDataMock = vi.fn().mockResolvedValue({
      projects: {},
      priorities: [],
    });

    vi.doMock('@/lib/project-data', () => ({
      fetchProjectData: fetchProjectDataMock,
    }));

    const mod = await import('@/app/api/projects/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty tasks and priorities when no projects', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
    expect(data.priorities).toEqual([]);
  });

  it('flattens project tasks with project name attached', async () => {
    fetchProjectDataMock.mockResolvedValue({
      projects: {
        proj1: [{ id: 'task-1', kind: 'review' }, { id: 'task-2', kind: 'test' }],
        proj2: [{ id: 'task-3', kind: 'run' }],
      },
      priorities: ['proj1', 'proj2'],
    });

    const res = await GET();
    const data = await res.json();

    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.find((t: any) => t.id === 'task-1').project).toBe('proj1');
    expect(data.tasks.find((t: any) => t.id === 'task-2').project).toBe('proj1');
    expect(data.tasks.find((t: any) => t.id === 'task-3').project).toBe('proj2');
    expect(data.priorities).toEqual(['proj1', 'proj2']);
  });
});

// ─── PATCH /api/projects/[schedId]/priority ───────────────────────────────────

describe('PATCH /api/projects/[schedId]/priority', () => {
  let PATCH: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let writePriorityYamlMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: {
        'sched-1': { project: 'proj1', scheduler: 'default', priority: 'high' },
      },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    writePriorityYamlMock = vi.fn();

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (req: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const auth = req.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
      writePriorityYaml: writePriorityYamlMock,
      PRIORITY_ORDER: ['critical', 'high', 'medium', 'low'],
    }));

    const mod = await import('@/app/api/projects/[schedId]/priority/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/sched-1/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'high' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 422 for invalid priority value', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'urgent' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('priority must be one of');
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'high' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('sets priority and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'medium' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(writePriorityYamlMock).toHaveBeenCalledOnce();
    expect(writePriorityYamlMock).toHaveBeenCalledWith('proj1', 'default', 'medium');
  });
});

// ─── POST /api/projects/[schedId]/pause ──────────────────────────────────────

describe('POST /api/projects/[schedId]/pause', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let pauseAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: { 'sched-1': { project: 'proj1' } },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    pauseAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (req: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const auth = req.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/launchagent', () => ({
      pauseAll: pauseAllMock,
    }));

    const mod = await import('@/app/api/projects/[schedId]/pause/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/sched-1/pause', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/pause', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('pauses project and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/pause', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(pauseAllMock).toHaveBeenCalledWith(['sched-1']);
  });
});

// ─── POST /api/projects/[schedId]/resume ─────────────────────────────────────

describe('POST /api/projects/[schedId]/resume', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let resumeAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: { 'sched-1': { project: 'proj1' } },
      claudeBin: 'claude',
      logDir: '/tmp/logs',
    });
    resumeAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (req: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const auth = req.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/launchagent', () => ({
      resumeAll: resumeAllMock,
    }));

    const mod = await import('@/app/api/projects/[schedId]/resume/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/sched-1/resume', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/resume', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('resumes project and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/resume', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(resumeAllMock).toHaveBeenCalledWith(['sched-1']);
  });
});

// ─── GET /api/projects/[schedId]/detail ──────────────────────────────────────

describe('GET /api/projects/[schedId]/detail', () => {
  let GET: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let readRunHistoryMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: {
        'sched-1': {
          project: 'proj1',
          scheduler: 'default',
          prompt: null,
          persona: [],
          github: null,
          priority: 'high',
        },
      },
    });
    readRunHistoryMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: getImproveConfigMock,
    }));

    vi.doMock('@/lib/run-history', () => ({
      readRunHistory: readRunHistoryMock,
    }));

    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return { ...actual, homedir: () => '/tmp/test-home' };
    });

    const mod = await import('@/app/api/projects/[schedId]/detail/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for unknown schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('returns project detail with empty run history', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('sched-1');
    expect(data.project).toBe('proj1');
    expect(data.job).toBe('default');
    expect(data.run_history).toEqual([]);
  });

  it('returns run history entries', async () => {
    readRunHistoryMock.mockReturnValue([
      { started: 1000, ended: 2000, durationS: 1000, exitCode: 0 },
      { started: 3000, ended: 4000, durationS: 1000, exitCode: 1 },
    ]);

    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();

    expect(data.run_history).toHaveLength(2);
    expect(data.run_history[0].exit_code).toBe(0);
    expect(data.run_history[1].exit_code).toBe(1);
  });

  it('includes null prompt content when no prompt path', async () => {
    const req = new NextRequest('http://localhost/api/projects/sched-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'sched-1' }) });
    const data = await res.json();
    expect(data.prompt_content).toBeNull();
    expect(data.memory_content).toBeNull();
  });
});
