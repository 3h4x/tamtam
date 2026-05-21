import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LogFrame } from '@/lib/jobs/log-persistence';

describe('GET /api/jobs/{jobId}/logs', () => {
  let GET: typeof import('@/app/api/jobs/[jobId]/logs/route').GET;
  let readJobLogsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    readJobLogsMock = vi.fn().mockReturnValue([]);

    vi.doMock('@/lib/jobs/log-persistence', () => ({
      readJobLogs: readJobLogsMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/logs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty logs array when no logs exist', async () => {
    readJobLogsMock.mockReturnValue([]);
    const req = new NextRequest('http://localhost/api/jobs/job-123/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-123' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.logs).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('returns log frames with count', async () => {
    const frames: LogFrame[] = [
      { type: 'text', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'text', content: 'World', timestamp: '2024-01-01T00:00:01Z' },
    ];
    readJobLogsMock.mockReturnValue(frames);

    const req = new NextRequest('http://localhost/api/jobs/job-456/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'job-456' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.logs).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.logs[0].content).toBe('Hello');
    expect(data.logs[1].content).toBe('World');
  });

  it('calls readJobLogs with correct jobId', async () => {
    const req = new NextRequest('http://localhost/api/jobs/my-job/logs');
    await GET(req, { params: Promise.resolve({ jobId: 'my-job' }) });
    expect(readJobLogsMock).toHaveBeenCalledWith('my-job');
  });

  it('returns error when readJobLogs throws', async () => {
    readJobLogsMock.mockImplementation(() => {
      throw new Error('disk error');
    });
    const req = new NextRequest('http://localhost/api/jobs/bad-job/logs');
    const res = await GET(req, { params: Promise.resolve({ jobId: 'bad-job' }) });
    const data = await res.json();
    expect(data.logs).toBeNull();
    expect(data.error).toContain('disk error');
  });

  describe('jobId boundary validation (path traversal protection)', () => {
    // Regression guards for the path-traversal hardening. The route now
    // rejects any jobId that doesn't match /^[A-Za-z0-9._:-]+$/ — that's a
    // strict superset of every observed real jobId shape (project name,
    // kind including `agent:audit-logs`, numeric timestamp) and forbids
    // the traversal payloads that would otherwise let the request read
    // arbitrary `.log` files anywhere readJobLogs can reach.

    it('rejects jobIds containing path separators', async () => {
      const req = new NextRequest('http://localhost/api/jobs/x/logs');
      const res = await GET(req, { params: Promise.resolve({ jobId: '../../etc/passwd' }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/invalid jobId/i);
      expect(readJobLogsMock).not.toHaveBeenCalled();
    });

    it('rejects jobIds containing backslash separators', async () => {
      const req = new NextRequest('http://localhost/api/jobs/x/logs');
      const res = await GET(req, { params: Promise.resolve({ jobId: 'foo\\bar' }) });
      expect(res.status).toBe(400);
      expect(readJobLogsMock).not.toHaveBeenCalled();
    });

    it('rejects null bytes and control characters', async () => {
      const req = new NextRequest('http://localhost/api/jobs/x/logs');
      const res = await GET(req, { params: Promise.resolve({ jobId: 'foo\x00bar' }) });
      expect(res.status).toBe(400);
      expect(readJobLogsMock).not.toHaveBeenCalled();
    });

    it('accepts realistic jobIds with colons (agent kinds) and dashes', async () => {
      // Verify the allow-list is broad enough for actual TamTam jobIds.
      const realisticIds = [
        'tamtam-run-1779307798309000',
        'borged-agent:audit-logs-1779313592005000',
        'system:tamtam:documentation-reindex-vectors',
      ];
      for (const id of realisticIds) {
        readJobLogsMock.mockReturnValue([]);
        const req = new NextRequest('http://localhost/api/jobs/x/logs');
        const res = await GET(req, { params: Promise.resolve({ jobId: id }) });
        expect(res.status).toBe(200);
      }
    });
  });
});
