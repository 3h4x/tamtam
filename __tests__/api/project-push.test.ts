import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── GET /api/projects/by-project/[name]/push/preview ─────────────────────────

describe('GET /api/projects/by-project/[name]/push/preview', () => {
  let GET: any;
  let execMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });


    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/push/preview/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();

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
  let launchProjectPushMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    launchProjectPushMock = vi.fn().mockReturnValue({ jobId: 'test-job-id' });
    vi.doMock('@/lib/start-push', () => ({ launchProjectPush: launchProjectPushMock }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/push/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 if project not found', async () => {
    launchProjectPushMock.mockReturnValue({ error: 'project not found' });
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns started status with job_id on success', async () => {
    launchProjectPushMock.mockReturnValue({ jobId: 'launch-xyz' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBe('launch-xyz');
  });

  it('calls launchProjectPush with the correct project name', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/my-repo/push', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ projectName: 'my-repo' }) });
    expect(launchProjectPushMock).toHaveBeenCalledWith('my-repo');
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
    expect(res.status).toBe(500);
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

  it('passes --tools "" and --system-prompt to claude to prevent tool use and CLAUDE.md injection', async () => {
    let capturedArgs: string[] = [];
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--print')) {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0, stdout: '1. feat: add thing', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/push/generate', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(capturedArgs).toContain('--tools');
    expect(capturedArgs[capturedArgs.indexOf('--tools') + 1]).toBe('');
    expect(capturedArgs).toContain('--system-prompt');
    expect(capturedArgs).toContain('--print');
  });
});
