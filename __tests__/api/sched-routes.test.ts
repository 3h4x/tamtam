import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Shared mock config
const mockProjects = {
  'proj-crit': { project: 'my-project', scheduler: 'review', prompt: null, github: null, persona: null },
  'other-proj': { project: 'other', scheduler: null, prompt: null, github: null, persona: null },
};

describe('POST /api/projects/[schedId]/pause', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let pauseAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({ projects: mockProjects });
    pauseAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: getImproveConfigMock }));
    vi.doMock('@/lib/launchagent', () => ({ pauseAll: pauseAllMock }));

    const mod = await import('@/app/api/projects/[schedId]/pause/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for nonexistent schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/pause', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('calls pauseAll with schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/pause', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    expect(res.status).toBe(200);
    expect(pauseAllMock).toHaveBeenCalledWith(['proj-crit']);
  });

  it('returns ok on success', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/pause', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('returns 401 when auth fails', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      checkAuth: () => new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
    }));
    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: vi.fn().mockReturnValue({ projects: mockProjects }) }));
    vi.doMock('@/lib/launchagent', () => ({ pauseAll: vi.fn() }));

    const mod = await import('@/app/api/projects/[schedId]/pause/route');
    const req = new NextRequest('http://localhost/api/projects/proj-crit/pause', { method: 'POST' });
    const res = await mod.POST(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/projects/[schedId]/resume', () => {
  let POST: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let resumeAllMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({ projects: mockProjects });
    resumeAllMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: getImproveConfigMock }));
    vi.doMock('@/lib/launchagent', () => ({ resumeAll: resumeAllMock }));

    const mod = await import('@/app/api/projects/[schedId]/resume/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for nonexistent schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/resume', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('calls resumeAll with schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/resume', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    expect(res.status).toBe(200);
    expect(resumeAllMock).toHaveBeenCalledWith(['proj-crit']);
  });

  it('returns ok on success', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/resume', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});

describe('PATCH /api/projects/[schedId]/priority', () => {
  let PATCH: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let writePriorityYamlMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({ projects: mockProjects });
    writePriorityYamlMock = vi.fn();

    vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
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
  });

  it('returns 422 for invalid priority', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'superurgent' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.detail).toContain('priority must be one of');
  });

  it('returns 404 for nonexistent schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'high' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('calls writePriorityYaml with correct args', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'high' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    expect(res.status).toBe(200);
    expect(writePriorityYamlMock).toHaveBeenCalledWith('my-project', 'review', 'high');
  });

  it('returns ok on success', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-crit/priority', {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'critical' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('accepts all valid priority values', async () => {
    for (const priority of ['critical', 'high', 'medium', 'low']) {
      vi.resetModules();
      writePriorityYamlMock = vi.fn();
      vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
      vi.doMock('@/lib/scheduling', () => ({
        getImproveConfig: vi.fn().mockReturnValue({ projects: mockProjects }),
        writePriorityYaml: writePriorityYamlMock,
        PRIORITY_ORDER: ['critical', 'high', 'medium', 'low'],
      }));
      const mod = await import('@/app/api/projects/[schedId]/priority/route');
      const req = new NextRequest('http://localhost/api/projects/proj-crit/priority', {
        method: 'PATCH',
        body: JSON.stringify({ priority }),
      });
      const res = await mod.PATCH(req, { params: Promise.resolve({ schedId: 'proj-crit' }) });
      expect(res.status).toBe(200);
    }
  });
});

describe('GET /api/projects/[schedId]/detail', () => {
  let GET: any;
  let getImproveConfigMock: ReturnType<typeof vi.fn>;
  let readRunHistoryMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getImproveConfigMock = vi.fn().mockReturnValue({
      projects: {
        'proj-1': { project: 'my-project', scheduler: 'review', prompt: null, github: null, persona: null },
      },
    });
    readRunHistoryMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: getImproveConfigMock }));
    vi.doMock('@/lib/run-history', () => ({ readRunHistory: readRunHistoryMock }));
    // Mock os.homedir to avoid reading real home directory
    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return { ...actual, homedir: () => '/nonexistent/home' };
    });

    const mod = await import('@/app/api/projects/[schedId]/detail/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 for nonexistent schedId', async () => {
    const req = new NextRequest('http://localhost/api/projects/unknown/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('returns project detail', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'proj-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('proj-1');
    expect(data.project).toBe('my-project');
    expect(data.job).toBe('review');
  });

  it('returns null prompt_content when prompt path not set', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'proj-1' }) });
    const data = await res.json();
    expect(data.prompt_content).toBeNull();
  });

  it('returns null memory_content when memory file not found', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'proj-1' }) });
    const data = await res.json();
    expect(data.memory_content).toBeNull();
  });

  it('calls readRunHistory and includes run_history', async () => {
    readRunHistoryMock.mockReturnValue([
      { started: 1000, ended: 1060, durationS: 60, exitCode: 0 },
    ]);

    const req = new NextRequest('http://localhost/api/projects/proj-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'proj-1' }) });
    const data = await res.json();
    expect(readRunHistoryMock).toHaveBeenCalledWith('proj-1', 20);
    expect(data.run_history).toHaveLength(1);
    expect(data.run_history[0].exit_code).toBe(0);
    expect(data.run_history[0].duration_s).toBe(60);
  });

  it('returns empty run_history when no runs', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/detail');
    const res = await GET(req, { params: Promise.resolve({ schedId: 'proj-1' }) });
    const data = await res.json();
    expect(data.run_history).toEqual([]);
  });
});
