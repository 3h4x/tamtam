import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('GET /api/health', () => {
  let GET: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/app/api/health/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns status ok', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});

describe('GET /api/projects', () => {
  let GET: any;
  let fetchProjectDataMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    fetchProjectDataMock = vi.fn().mockResolvedValue({
      projects: {},
      priorities: {},
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
    expect(data.priorities).toEqual({});
  });

  it('returns tasks flattened from all projects', async () => {
    fetchProjectDataMock.mockResolvedValue({
      projects: {
        'proj-a': [
          { id: 'task-1', name: 'Task 1' },
          { id: 'task-2', name: 'Task 2' },
        ],
        'proj-b': [{ id: 'task-3', name: 'Task 3' }],
      },
      priorities: { 'proj-a': 'high', 'proj-b': 'low' },
    });

    const res = await GET();
    const data = await res.json();
    expect(data.tasks).toHaveLength(3);
    expect(data.priorities['proj-a']).toBe('high');
  });

  it('injects project name into each task', async () => {
    fetchProjectDataMock.mockResolvedValue({
      projects: {
        'my-proj': [{ id: 'task-1', kind: 'review' }],
      },
      priorities: {},
    });

    const res = await GET();
    const data = await res.json();
    expect(data.tasks[0].project).toBe('my-proj');
  });

  it('handles multiple tasks per project', async () => {
    fetchProjectDataMock.mockResolvedValue({
      projects: {
        'proj-x': [
          { id: 't1', kind: 'run' },
          { id: 't2', kind: 'review' },
          { id: 't3', kind: 'test' },
        ],
      },
      priorities: {},
    });

    const res = await GET();
    const data = await res.json();
    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.every((t: any) => t.project === 'proj-x')).toBe(true);
  });

  it('calls fetchProjectData', async () => {
    await GET();
    expect(fetchProjectDataMock).toHaveBeenCalledOnce();
  });
});
