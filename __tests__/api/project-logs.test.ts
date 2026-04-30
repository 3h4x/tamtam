import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/logs', () => {
  let GET: any;
  let tempDir: string;
  let logDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-proj-logs-test-'));
    logDir = join(tempDir, 'logs');
    mkdirSync(logDir, { recursive: true });

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir,
      }),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/logs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty logs when logDir does not exist', async () => {
    vi.resetModules();
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: join(tempDir, 'nonexistent-logs'),
      }),
    }));
    const mod = await import('@/app/api/projects/by-project/[projectName]/logs/route');
    const handler = mod.GET;

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/logs');
    const res = await handler(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.logs).toEqual([]);
  });

  it('returns empty logs when no log files match project name', async () => {
    writeFileSync(join(logDir, 'other-project-run.log'), 'some content');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/logs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.logs).toEqual([]);
  });

  it('returns logs that match the project name', async () => {
    writeFileSync(join(logDir, 'proj1-run-123.log'), 'log content 1');
    writeFileSync(join(logDir, 'proj1-review-456.log'), 'log content 2');
    writeFileSync(join(logDir, 'other-run-789.log'), 'other content');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/logs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.logs.length).toBe(2);
    expect(data.logs.every((l: any) => l.filename.includes('proj1'))).toBe(true);
  });

  it('includes filename and content in each log entry', async () => {
    writeFileSync(join(logDir, 'proj1-run-001.log'), 'hello world');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/logs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.logs[0].filename).toBe('proj1-run-001.log');
    expect(data.logs[0].content).toBe('hello world');
  });

  it('returns at most 5 log files', async () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(logDir, `proj1-run-00${i}.log`), `content ${i}`);
    }

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/logs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.logs.length).toBeLessThanOrEqual(5);
  });
});
