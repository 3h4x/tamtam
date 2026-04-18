import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

function makeAuthMock() {
  return {
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
  };
}

// ─── GET /api/projects/by-project/[name]/push/preview ─────────────────────────

describe('GET /api/projects/by-project/[name]/push/preview', () => {
  let GET: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/auth', () => makeAuthMock());
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/preview/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns empty files and "No changes" summary when nothing changed', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toEqual([]);
    expect(data.summary).toBe('No changes');
  });

  it('returns files list from name-status output', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--name-status')) {
        return Promise.resolve({ exitCode: 0, stdout: 'M\tsrc/foo.ts\nA\tsrc/bar.ts\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(data.files).toHaveLength(2);
    expect(data.files[0].status).toBe('M');
    expect(data.files[0].filename).toBe('src/foo.ts');
    expect(data.files[1].status).toBe('A');
    expect(data.files[1].filename).toBe('src/bar.ts');
  });

  it('includes untracked files from ls-files output', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--others')) {
        return Promise.resolve({ exitCode: 0, stdout: 'new-file.ts\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/preview');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(data.files.some((f: any) => f.filename === 'new-file.ts' && f.status === 'A')).toBe(true);
  });
});

// ─── POST /api/projects/by-project/[name]/push ────────────────────────────────

describe('POST /api/projects/by-project/[name]/push', () => {
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/auth', () => makeAuthMock());
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns success with no changes message when nothing to push', async () => {
    // add succeeds, status returns empty
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--porcelain')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.message).toContain('No changes');
  });

  it('returns 400 if git add fails', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'git add failed' });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Git add failed');
  });

  it('pushes changes and returns success', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('-A')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('--porcelain') || args.includes('status')) {
        return Promise.resolve({ exitCode: 0, stdout: 'M file.ts\n', stderr: '' });
      }
      if (args.includes('commit')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('push')) {
        return Promise.resolve({ exitCode: 0, stdout: 'pushed', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
  });

  it('returns 400 if push fails', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('-A')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('--porcelain') || args.includes('status')) {
        return Promise.resolve({ exitCode: 0, stdout: 'M file.ts\n', stderr: '' });
      }
      if (args.includes('commit')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('push')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'push failed' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Push failed');
  });
});

// ─── POST /api/projects/by-project/[name]/push/execute ───────────────────────

describe('POST /api/projects/by-project/[name]/push/execute', () => {
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/auth', () => makeAuthMock());
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/gh-status', () => ({ invalidateProject: vi.fn() }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/execute/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: update' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns success with no changes when nothing staged', async () => {
    // diff --cached returns nothing
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--cached') && args.includes('--name-status')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain('No changes');
  });

  it('returns 400 if commit fails', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--cached') && args.includes('--name-status')) {
        return Promise.resolve({ exitCode: 0, stdout: 'M\tfile.ts', stderr: '' });
      }
      if (args.includes('commit')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'commit failed' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Commit failed');
  });

  it('commits and pushes changes, returns success', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--cached') && args.includes('--name-status')) {
        return Promise.resolve({ exitCode: 0, stdout: 'M\tfile.ts', stderr: '' });
      }
      if (args.includes('commit')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('push') && !args.includes('-u')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (args.includes('rev-parse')) {
        return Promise.resolve({ exitCode: 0, stdout: 'abc1234', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/execute', {
      method: 'POST',
      body: JSON.stringify({ message: 'chore: test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.commit_sha).toBe('abc1234');
  });
});

// ─── POST /api/projects/by-project/[name]/push/generate ──────────────────────

describe('POST /api/projects/by-project/[name]/push/generate', () => {
  let POST: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@/lib/auth', () => makeAuthMock());
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ claudeBin: 'claude' }),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/generate/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns commit message options from claude output', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '1. feat: add new feature\n2. chore: update config\n3. fix: fix bug\n4. refactor: clean up\n5. docs: update readme',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.options).toHaveLength(5);
    expect(data.options[0]).toBe('feat: add new feature');
    expect(data.options[1]).toBe('chore: update config');
    expect(data.error).toBeNull();
  });

  it('returns error in response body when exec throws', async () => {
    execMock.mockRejectedValue(new Error('exec failed'));

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.options).toEqual([]);
    expect(data.error).toContain('exec failed');
  });

  it('always uses haiku model regardless of project settings', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({ exitCode: 0, stdout: '1. feat: add thing', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.model).toBe('haiku');

    // Verify claude was called with --model haiku
    const claudeCall = execMock.mock.calls.find(([, args]: any) => args.includes('--print'));
    expect(claudeCall![1]).toContain('haiku');
  });

  it('filters out lines that do not match conventional commit type prefix', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: [
            '1. feat: valid commit',
            '2. This is just prose and should be filtered',
            '3. fix: another valid one',
            '4. random text without type',
            '5. chore: cleanup',
          ].join('\n'),
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.options).toHaveLength(3);
    expect(data.options).toContain('feat: valid commit');
    expect(data.options).toContain('fix: another valid one');
    expect(data.options).toContain('chore: cleanup');
    expect(data.options).not.toContain('This is just prose and should be filtered');
  });

  it('strips backtick and quote wrapping before checking commit type', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: [
            '1. `feat: wrapped in backticks`',
            "2. 'fix: single quotes'",
            '3. "docs: double quotes"',
            '4. *refactor: asterisk wrapped*',
          ].join('\n'),
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.options).toHaveLength(4);
    expect(data.options[0]).toBe('feat: wrapped in backticks');
    expect(data.options[1]).toBe('fix: single quotes');
    expect(data.options[2]).toBe('docs: double quotes');
    expect(data.options[3]).toBe('refactor: asterisk wrapped');
  });

  it('accepts scoped commit type like feat(ui):', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '1. feat(ui): add button component',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.options).toContain('feat(ui): add button component');
  });

  it('returns empty options when all lines fail commit type filter', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Here are some commit options:\n- option one\n- option two',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.options).toEqual([]);
    expect(data.error).toBeNull();
  });
});
