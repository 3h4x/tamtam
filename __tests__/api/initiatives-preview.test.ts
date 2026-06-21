import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ProbeResults } from '@/lib/orchestrator/initiative-miner';

const mockRunProbes = vi.fn<(project: string, projectPath: string) => Promise<ProbeResults>>();
const mockResolveProjectPath = vi.fn<(projectName: string) => string | null>();

vi.mock('@/lib/orchestrator/initiative-probes', () => ({
  runProbes: mockRunProbes,
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mockResolveProjectPath,
}));

const { GET } = await import('@/app/api/projects/by-project/[projectName]/initiatives/preview/route');

function makeRequest(projectName: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/by-project/${projectName}/initiatives/preview`);
}

function makeParams(projectName: string) {
  return { params: Promise.resolve({ projectName }) };
}

describe('GET /api/projects/by-project/[projectName]/initiatives/preview', () => {
  beforeEach(() => {
    mockRunProbes.mockReset();
    mockResolveProjectPath.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when project is not found', async () => {
    mockResolveProjectPath.mockReturnValue(null);
    const res = await GET(makeRequest('unknown-project'), makeParams('unknown-project'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toBe('project not found');
  });

  it('returns 200 with candidates derived from probe results', async () => {
    mockResolveProjectPath.mockReturnValue('/some/path/to/project');
    const fakeResults: ProbeResults = {
      project: 'my-project',
      findings: [
        { kind: 'lint', title: 'Fix lint errors', rationale: 'pnpm lint reported problems', prompt: 'Run lint', dedupKey: 'lint:global' },
        { kind: 'todo', title: 'Resolve TODO in lib/foo.ts', rationale: 'lib/foo.ts has TODO markers', prompt: 'Fix todos', dedupKey: 'todo:lib/foo.ts' },
      ],
    };
    mockRunProbes.mockResolvedValue(fakeResults);

    const res = await GET(makeRequest('my-project'), makeParams('my-project'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project).toBe('my-project');
    expect(typeof body.generatedAt).toBe('number');
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates).toHaveLength(2);

    const lint = body.candidates.find((c: { kind: string }) => c.kind === 'lint');
    expect(lint).toBeDefined();
    expect(lint.title).toBe('Fix lint errors');
    expect(lint.rationale).toBe('pnpm lint reported problems');
    expect(typeof lint.score).toBe('number');
    expect(lint.dedupKey).toBe('lint:global');

    const todo = body.candidates.find((c: { kind: string }) => c.kind === 'todo');
    expect(todo).toBeDefined();
    expect(todo.dedupKey).toBe('todo:lib/foo.ts');

    // prompt should not be in the slim shape
    expect(lint.prompt).toBeUndefined();
  });

  it('returns empty candidates when probe finds nothing', async () => {
    mockResolveProjectPath.mockReturnValue('/some/path');
    mockRunProbes.mockResolvedValue({ project: 'empty-project', findings: [] });

    const res = await GET(makeRequest('empty-project'), makeParams('empty-project'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([]);
  });

  it('returns 500 when runProbes throws', async () => {
    mockResolveProjectPath.mockReturnValue('/some/path');
    mockRunProbes.mockRejectedValue(new Error('probe crashed'));

    const res = await GET(makeRequest('broken-project'), makeParams('broken-project'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('passes projectName and resolved path to runProbes', async () => {
    const resolvedPath = '/workspace/my-project';
    mockResolveProjectPath.mockReturnValue(resolvedPath);
    mockRunProbes.mockResolvedValue({ project: 'my-project', findings: [] });

    await GET(makeRequest('my-project'), makeParams('my-project'));
    expect(mockRunProbes).toHaveBeenCalledWith('my-project', resolvedPath);
  });
});
