import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/docs', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/docs/route').GET;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-docs-test-'));

    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/docs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs/promises');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns empty array when docs dir does not exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toEqual([]);
  });

  it('returns empty array when docs dir has no .md files', async () => {
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'notes.txt'), 'not markdown');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toEqual([]);
  });

  it('returns name and content for each .md file', async () => {
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'ARCHITECTURE.md'), '# Architecture\ndetails here');
    writeFileSync(join(tempDir, 'docs', 'API.md'), '# API\nendpoints here');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toHaveLength(2);
    const names = data.docs.map((d: any) => d.name);
    expect(names).toEqual(['API.md', 'ARCHITECTURE.md']);
    const arch = data.docs.find((d: any) => d.name === 'ARCHITECTURE.md');
    expect(arch.content).toBe('# Architecture\ndetails here');
  });

  it('ignores subdirectories', async () => {
    mkdirSync(join(tempDir, 'docs'));
    mkdirSync(join(tempDir, 'docs', 'subdir'));
    writeFileSync(join(tempDir, 'docs', 'subdir', 'nested.md'), '# Nested');
    writeFileSync(join(tempDir, 'docs', 'top.md'), '# Top');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].name).toBe('top.md');
  });

  it('returns README first then docs/ files sorted alphabetically', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# Root README');
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'TERMINAL.md'), '# Terminal');
    writeFileSync(join(tempDir, 'docs', 'AGENT.md'), '# Agent');
    writeFileSync(join(tempDir, 'docs', 'SETUP.md'), '# Setup');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toHaveLength(4);
    expect(data.docs[0].name).toBe('README.md');
    expect(data.docs.slice(1).map((d: { name: string }) => d.name)).toEqual(['AGENT.md', 'SETUP.md', 'TERMINAL.md']);
  });

  it('returns README without docs dir', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# Just a readme');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].name).toBe('README.md');
    expect(data.docs[0].path).toBe('README.md');
    expect(data.docs[0].content).toBe('# Just a readme');
  });

  it('finds a lowercase readme via the case-insensitive candidate loop', async () => {
    // The route iterates through README.md / readme.md / Readme.md
    // candidates. On case-insensitive filesystems (macOS, Windows by
    // default) any of those will match a file regardless of its on-disk
    // casing; on case-sensitive filesystems (Linux) the loop's later
    // candidates handle the lowercase / mixed-case variants. Verify the
    // content surfaces with the canonical display name either way.
    writeFileSync(join(tempDir, 'readme.md'), '# lowercase readme');
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'ZED.md'), '# Zed');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.docs[0].name).toBe('README.md'); // canonical display name
    expect(data.docs[0].content).toBe('# lowercase readme');
    // README still sorts to position 0 ahead of docs/ entries.
    expect(data.docs[1].name).toBe('ZED.md');
  });

  it('keeps README candidate precedence when multiple casings exist', async () => {
    vi.resetModules();
    const projectPath = '/virtual/project';
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(projectPath),
    }));
    vi.doMock('fs/promises', () => ({
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith('/README.md')) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return '# canonical readme';
        }
        if (path.endsWith('/readme.md')) return '# lowercase readme';
        throw new Error('missing');
      }),
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/docs/route');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await mod.GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].path).toBe('README.md');
    expect(data.docs[0].content).toBe('# canonical readme');
  });

  it('sorts docs entries when README candidates are absent', async () => {
    // The README candidate loop reads each known casing directly. If every
    // read misses, the sort logic must treat the result as "no README found".
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'GUIDE.md'), '# Guide');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].name).toBe('GUIDE.md');
  });
});
