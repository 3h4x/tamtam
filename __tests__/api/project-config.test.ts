import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/config', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-config-test-'));

    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);

    vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns empty test commands when no config files exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBe('proj1');
    expect(data.test_command).toBe('');
    expect(data.detected_test_command).toBe('');
    expect(data.effective_test_command).toBe('');
  });

  it('detects pnpm test when package.json has test script and pnpm-lock.yaml exists', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('pnpm test');
  });

  it('detects npm test when package.json has test script but no pnpm-lock.yaml', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('npm test');
  });

  it('detects python -m pytest when pyproject.toml exists', async () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest.ini_options]');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('python -m pytest');
  });

  it('detects python -m pytest when requirements.txt exists', async () => {
    writeFileSync(join(tempDir, 'requirements.txt'), 'pytest');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('python -m pytest');
  });

  it('detects forge test when foundry.toml exists', async () => {
    writeFileSync(join(tempDir, 'foundry.toml'), '[profile.default]');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.detected_test_command).toBe('forge test');
  });

  it('uses configured test_command over detected when set', async () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');

    vi.resetModules();
    // Mock with a configured test command
    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);
    vi.doMock('@/lib/auth', () => ({ checkAuth: () => null }));
    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: vi.fn() }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        projects: { 'proj1': { project: 'proj1', path: tempDir, test_command: 'custom test cmd', prompt: '', validate: false, persona: [], scheduler: null, github: null, priority: null } },
        claudeBin: 'claude',
        logDir: '/tmp/logs',
      }),
      writeProjectFieldYaml: vi.fn().mockReturnValue(true),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    const GET2 = mod.GET;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config');
    const res = await GET2(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.test_command).toBe('custom test cmd');
    expect(data.effective_test_command).toBe('custom test cmd');
  });
});

describe('PATCH /api/projects/by-project/{projectName}/config', () => {
  let PATCH: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let writeProjectFieldYamlMock: ReturnType<typeof vi.fn>;
  let reloadConfigMock: ReturnType<typeof vi.fn>;
  let clearProjectDataCacheMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    writeProjectFieldYamlMock = vi.fn().mockReturnValue(true);
    reloadConfigMock = vi.fn();
    clearProjectDataCacheMock = vi.fn();

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
      clearProjectDataCache: clearProjectDataCacheMock,
    }));
    vi.doMock('@/lib/config', () => ({ reloadConfig: reloadConfigMock }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ projects: {}, claudeBin: 'claude', logDir: '/tmp/logs' }),
      writeProjectFieldYaml: writeProjectFieldYamlMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/config/route');
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  it('requires authentication when Z_API_TOKEN is set', async () => {
    process.env.Z_API_TOKEN = 'secret';
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'npm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project not found', async () => {
    writeProjectFieldYamlMock.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'npm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('updates test_command and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pnpm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_command', 'pnpm test');
  });

  it('clears test_command when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(writeProjectFieldYamlMock).toHaveBeenCalledWith('proj1', 'test_command', null);
  });

  it('calls reloadConfig and clearProjectDataCache after update', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pytest' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(reloadConfigMock).toHaveBeenCalledOnce();
    expect(clearProjectDataCacheMock).toHaveBeenCalledOnce();
  });

  it('returns ok without writing when body has no test_command', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ other_field: 'value' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(writeProjectFieldYamlMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const mod = await import('@/app/api/health/route');
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});
