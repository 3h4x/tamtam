import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/job-storage';

async function collectSSEStream(
  response: Response,
  abortController: AbortController,
  timeoutMs = 500
): Promise<string[]> {
  const events: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      events.push(chunk);
    }
  } catch {
    // AbortError is expected
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return events;
}

describe('GET /api/streaming/[jobId]', () => {
  let tempDir: string;
  let GET: any;
  let getJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-test-'));
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/job-storage', () => ({
      getJob: getJobMock,
    }));

    // Mock claude-stream-parser to use the real implementation
    const { parseStreamLines } = await vi.importActual<typeof import('@/lib/claude-stream-parser')>(
      '@/lib/claude-stream-parser'
    );
    vi.doMock('@/lib/claude-stream-parser', () => ({ parseStreamLines }));

    const mod = await import('@/app/api/streaming/[jobId]/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns SSE content-type header', async () => {
    const logFile = join(tempDir, 'empty.log');
    writeFileSync(logFile, '');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    ac.abort();
  });

  it('replays existing raw log content when raw=1', async () => {
    const logFile = join(tempDir, 'test.log');
    writeFileSync(logFile, 'line one\nline two\nline three\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1?raw=1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    expect(combined).toContain('data: line one');
    expect(combined).toContain('data: line two');
    expect(combined).toContain('data: line three');
  });

  it('sends empty stream when log file does not exist', async () => {
    getJobMock.mockReturnValue({ logPath: '/nonexistent/path/job.log' } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    expect(response.status).toBe(200);
    // Abort quickly — no content expected
    const events = await collectSSEStream(response, ac, 100);
    const combined = events.join('');
    // No data events for missing file
    expect(combined).toBe('');
  });

  it('replays parsed stream events as text when raw not set', async () => {
    const logFile = join(tempDir, 'parsed.log');
    const textLine =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}}';
    writeFileSync(logFile, textLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    expect(combined).toContain('data: Hello world');
  });

  it('sends done event for result lines', async () => {
    const logFile = join(tempDir, 'done.log');
    const doneLine =
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"total_cost_usd":0.01,"session_id":"s1","result":"Output"}';
    writeFileSync(logFile, doneLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    expect(combined).toContain('event: done');
    expect(combined).toContain('"duration":1234');
  });

  it('sends thinking events as named SSE event', async () => {
    const logFile = join(tempDir, 'thinking.log');
    const thinkingLine =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me consider this"}}}';
    writeFileSync(logFile, thinkingLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('data: Let me consider this');
  });

  it('preserves newlines in text via multi-line SSE data encoding', async () => {
    const logFile = join(tempDir, 'multiline.log');
    const line1 = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line1\\nline2\\nline3"}}}';
    writeFileSync(logFile, line1 + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    // Multi-line SSE: each line gets its own "data:" prefix
    expect(combined).toContain('data: line1\ndata: line2\ndata: line3');
  });

  it('sends tool_use events with newlines preserved', async () => {
    const logFile = join(tempDir, 'tool.log');
    const toolStart = '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}';
    const toolStop = '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}';
    writeFileSync(logFile, toolStart + '\n' + toolStop + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectSSEStream(response, ac);

    const combined = events.join('');
    expect(combined).toContain('event: tool_use');
    expect(combined).toContain('"name":"Read"');
  });

  it('emits done via poll when job finishes after last log write (fs.watch miss)', async () => {
    const logFile = join(tempDir, 'polled.log');
    writeFileSync(logFile, 'test output line\n');
    // Start with job not finished — stream must poll, then finish.
    let finished = false;
    getJobMock.mockImplementation(() => ({
      logPath: logFile,
      finishedAt: finished ? Date.now() / 1000 : null,
      exitCode: finished ? 0 : null,
    } as any));

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-poll?raw=1', { signal: ac.signal });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-poll' }) });

    // Flip the job to finished AFTER the stream has already started and replayed initial content.
    setTimeout(() => { finished = true; }, 50);

    const events = await collectSSEStream(response, ac, 2000);
    const combined = events.join('');
    expect(combined).toContain('event: done');
    expect(combined).toContain('"exitCode":0');
  });

  it('uses fallback path from homedir when job has no logPath', async () => {
    getJobMock.mockReturnValue(null);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/unknown-job', {
      signal: ac.signal,
    });

    // Just verify it doesn't throw — the fallback path won't exist so stream is empty
    const response = await GET(request, { params: Promise.resolve({ jobId: 'unknown-job' }) });
    expect(response.status).toBe(200);
    ac.abort();
  });
});

describe('GET /api/streaming/[jobId] – extractLogDetail in done event', () => {
  let tempDir: string;
  let GET: any;
  let getJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-detail-test-'));
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);
    vi.doMock('@/lib/job-storage', () => ({ getJob: getJobMock }));

    const { parseStreamLines } = await vi.importActual<typeof import('@/lib/claude-stream-parser')>(
      '@/lib/claude-stream-parser'
    );
    vi.doMock('@/lib/claude-stream-parser', () => ({ parseStreamLines }));

    const mod = await import('@/app/api/streaming/[jobId]/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function getDonePayload(logContent: string, exitCode: number): Promise<Record<string, unknown>> {
    const logFile = join(tempDir, `test-${Date.now()}.log`);
    writeFileSync(logFile, logContent);
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode,
    } as any);

    const ac = new AbortController();
    const request = new NextRequest(`http://localhost/api/streaming/job-detail?raw=1`, {
      signal: ac.signal,
    });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-detail' }) });
    const events = await collectSSEStream(response, ac, 300);
    const combined = events.join('');

    const match = combined.match(/event: done\ndata: (.+)/);
    if (!match) throw new Error(`No done event found in: ${combined}`);
    return JSON.parse(match[1]);
  }

  it('done event with exitCode=0 has no detail field', async () => {
    const logFile = join(tempDir, 'ok.log');
    writeFileSync(logFile, 'some output\n');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const request = new NextRequest(`http://localhost/api/streaming/job-ok?raw=1`, { signal: ac.signal });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-ok' }) });
    const events = await collectSSEStream(response, ac, 300);
    const combined = events.join('');

    const match = combined.match(/event: done\ndata: (.+)/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload).not.toHaveProperty('detail');
    expect(payload.exitCode).toBe(0);
  });

  it('done event with exitCode=1 and missing log has detail "log file missing"', async () => {
    getJobMock.mockReturnValue({
      logPath: join(tempDir, 'nonexistent.log'),
      finishedAt: Date.now() / 1000,
      exitCode: 1,
    } as any);

    const ac = new AbortController();
    const request = new NextRequest(`http://localhost/api/streaming/job-missing?raw=1`, { signal: ac.signal });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-missing' }) });
    const events = await collectSSEStream(response, ac, 300);
    const combined = events.join('');

    const match = combined.match(/event: done\ndata: (.+)/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload.detail).toBe('log file missing');
  });

  it('done event with empty log has detail about empty output', async () => {
    const payload = await getDonePayload('', 1);
    expect(payload.detail).toMatch(/empty/i);
    expect(payload.exitCode).toBe(1);
  });

  it('done event with non-JSON lines returns last non-JSON lines as detail', async () => {
    const content = 'some error output\nanother error line\n';
    const payload = await getDonePayload(content, 2);
    expect(payload.detail).toContain('some error output');
    expect(payload.detail).toContain('another error line');
  });

  it('done event with only stream_event JSON has partial-output detail', async () => {
    const streamLine = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}}';
    const payload = await getDonePayload(streamLine + '\n', 137);
    expect(typeof payload.detail).toBe('string');
    expect(payload.detail as string).toContain('partial output');
    expect(payload.exitCode).toBe(137);
  });

  it('done event with only non-stream JSON (no stream_event) has never-emitted-result detail', async () => {
    const jsonLine = '{"type":"system","subtype":"init","session_id":"abc123"}';
    const payload = await getDonePayload(jsonLine + '\n', 1);
    expect(typeof payload.detail).toBe('string');
    expect(payload.detail as string).toMatch(/never emitted a final result|no.*result/i);
  });

  it('done event detail respects last 20 non-JSON lines limit', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`).join('\n');
    const payload = await getDonePayload(lines + '\n', 1);
    expect(payload.detail as string).toContain('error line 25');
    expect(payload.detail as string).toContain('error line 6');
    expect(payload.detail as string).not.toContain('error line 5');
  });
});
