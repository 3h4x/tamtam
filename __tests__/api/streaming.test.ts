import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobData } from '@/lib/jobs/job-storage';

// Mutable delegates — reassigned per test; shared across all four describes.
let getJobImpl: ReturnType<typeof vi.fn>;
let probeJobStatusImpl: ReturnType<typeof vi.fn>;

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...args: unknown[]) => (getJobImpl as (...a: unknown[]) => unknown)(...args),
  probeJobStatus: (...args: unknown[]) => (probeJobStatusImpl as (...a: unknown[]) => unknown)(...args),
}));

// Use the real parser (passthrough mock) — loaded once instead of per-test.
vi.mock('@/lib/jobs/claude-stream-parser', async () => {
  return await vi.importActual('@/lib/jobs/claude-stream-parser');
});

import { GET } from '@/app/api/streaming/[jobId]/route';

async function collectClosedSSEStream(response: Response): Promise<string[]> {
  const events: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return events;
}

async function collectSSEStream(
  response: Response,
  abortController: AbortController,
  timeoutMs = 120
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
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getJobMock = vi.fn().mockReturnValue(null);
    probeJobStatusMock = vi.fn().mockResolvedValue('running');
    getJobImpl = getJobMock;
    probeJobStatusImpl = probeJobStatusMock;
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
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1?raw=1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('data: line one');
    expect(combined).toContain('data: line two');
    expect(combined).toContain('data: line three');
  });

  it('redacts existing raw log content before streaming', async () => {
    const logFile = join(tempDir, 'raw-secret.log');
    writeFileSync(logFile, 'token=ghp_abcdefghijklmnopqrstuvwxyz123456\nordinary line\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1?raw=1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('data: token=[REDACTED]');
    expect(combined).toContain('data: ordinary line');
    expect(combined).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
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
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');
    // No data events for missing file
    expect(combined).toBe('');
  });

  it('replays parsed stream events as text when raw not set', async () => {
    const logFile = join(tempDir, 'parsed.log');
    const textLine =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}}';
    writeFileSync(logFile, textLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('data: Hello world');
  });

  it('redacts parsed stream event text before streaming', async () => {
    const logFile = join(tempDir, 'parsed-secret.log');
    const textLine =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"token=ghp_abcdefghijklmnopqrstuvwxyz123456 kept"}}}';
    writeFileSync(logFile, textLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('data: token=[REDACTED] kept');
    expect(combined).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('sends done event for result lines', async () => {
    const logFile = join(tempDir, 'done.log');
    const doneLine =
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"total_cost_usd":0.01,"session_id":"s1","result":"Output"}';
    writeFileSync(logFile, doneLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: done');
    expect(combined).toContain('"duration":1234');
  });

  it('closes after replaying a result line even when the job row is still running', async () => {
    const logFile = join(tempDir, 'stale-running-result.log');
    const doneLine =
      '{"type":"result","subtype":"error","is_error":true,"duration_ms":1234,"session_id":"s1","result":"[codex-shim] codex produced no assistant output"}';
    writeFileSync(logFile, doneLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: null, exitCode: null } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: done');
    expect(combined).toContain('"error":true');
    expect(combined).toContain('[codex-shim] codex produced no assistant output');
  });

  it('sends thinking events as named SSE event', async () => {
    const logFile = join(tempDir, 'thinking.log');
    const thinkingLine =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me consider this"}}}';
    writeFileSync(logFile, thinkingLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('data: Let me consider this');
  });

  it('preserves newlines in text via multi-line SSE data encoding', async () => {
    const logFile = join(tempDir, 'multiline.log');
    const line1 = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line1\\nline2\\nline3"}}}';
    writeFileSync(logFile, line1 + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    // Multi-line SSE: each line gets its own "data:" prefix
    expect(combined).toContain('data: line1\ndata: line2\ndata: line3');
  });

  it('sends tool_use events with newlines preserved', async () => {
    const logFile = join(tempDir, 'tool.log');
    const toolStart = '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}';
    const toolStop = '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}';
    writeFileSync(logFile, toolStart + '\n' + toolStop + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-1', {
      signal: ac.signal,
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-1' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: tool_use');
    expect(combined).toContain('"name":"Read"');
  });

  // Regression: review logs with structured tool_result content (array of
  // {type:"text",text:"..."} blocks) used to dump as raw JSON in the
  // terminal. The parser now extracts the text; the SSE stream must deliver
  // the readable payload, not the stringified blob.
  it('extracts text from array-shaped tool_result instead of dumping raw JSON', async () => {
    const logFile = join(tempDir, 'toolresult.log');
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: [{ type: 'text', text: 'readable tool output' }],
        }],
      },
    });
    writeFileSync(logFile, toolResultLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-tr', { signal: ac.signal });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-tr' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: tool_result');
    expect(combined).toContain('readable tool output');
    // Must NOT contain the raw [{"type":"text"...}] blob anywhere.
    expect(combined).not.toMatch(/\[\{"type":"text"/);
  });

  it('does not emit raw usage/metadata JSON as text for message_delta events', async () => {
    // This is the exact shape that leaked into the release terminal —
    // usage stats with ephemeral_5m_input_tokens etc. With the fix, these
    // events produce no output at all (they carry no user-visible text).
    const logFile = join(tempDir, 'meta.log');
    const metaLine = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 20,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1936 },
          service_tier: 'standard',
        },
      },
      parent_tool_use_id: null,
    });
    writeFileSync(logFile, metaLine + '\n');
    getJobMock.mockReturnValue({ logPath: logFile } as Partial<JobData>);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-meta', { signal: ac.signal });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-meta' }) });
    const events = await collectSSEStream(response, ac, 200);

    const combined = events.join('');
    // No data events should contain raw ephemeral/usage fields.
    expect(combined).not.toContain('ephemeral_5m_input_tokens');
    expect(combined).not.toContain('parent_tool_use_id');
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

  it('does not probe job status once finishedAt is set', async () => {
    const logFile = join(tempDir, 'probe-stop.log');
    writeFileSync(logFile, 'done output\n');
    // Job is already finished before the poller gets a chance to probe.
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const request = new NextRequest('http://localhost/api/streaming/job-probe-stop?raw=1', {
      signal: ac.signal,
    });
    const response = await GET(request, { params: Promise.resolve({ jobId: 'job-probe-stop' }) });
    await collectClosedSSEStream(response);

    // Finished-at path short-circuits before the poller ever starts,
    // so probeJobStatus must never be called.
    expect(probeJobStatusMock).not.toHaveBeenCalled();
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
  let getJobMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-detail-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getJobMock = vi.fn().mockReturnValue(null);
    getJobImpl = getJobMock;
    probeJobStatusImpl = vi.fn().mockResolvedValue('running');
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
    const events = await collectClosedSSEStream(response);
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
    const events = await collectClosedSSEStream(response);
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
    const events = await collectClosedSSEStream(response);
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
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"foo"}}}';
    const payload = await getDonePayload(line + '\n', 1);
    expect(payload.detail).toMatch(/partial/i);
  });

  it('done event with only non-stream JSON (no stream_event) has never-emitted-result detail', async () => {
    const line = '{"type":"other","some":"data"}';
    const payload = await getDonePayload(line + '\n', 1);
    expect(payload.detail).toMatch(/never emitted|no result/i);
  });

  it('done event detail respects last 20 non-JSON lines limit', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`).join('\n');
    const payload = await getDonePayload(lines + '\n', 1);
    expect(payload.detail as string).toContain('error line 25');
    expect(payload.detail as string).toContain('error line 6');
    expect(payload.detail as string).not.toContain('error line 5');
  });

  it('done event with only [tamtam] wrapper lines has specific wrapper-only detail', async () => {
    const wrapperContent = [
      '[tamtam] launching: claude --print --model haiku',
      '[tamtam] exit 1',
    ].join('\n') + '\n';
    const payload = await getDonePayload(wrapperContent, 1);
    expect(payload.detail as string).toContain('immediately without producing any output');
  });
});

describe('GET /api/streaming/[jobId] – passthrough mode', () => {
  let tempDir: string;
  let getJobMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-pt-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getJobMock = vi.fn().mockReturnValue(null);
    getJobImpl = getJobMock;
    probeJobStatusImpl = vi.fn().mockResolvedValue('running');
  });

  it('emits non-JSON lines as raw SSE events', async () => {
    const logFile = join(tempDir, 'pt.log');
    writeFileSync(logFile, 'plain shell output\nmore shell output\n');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-pt?passthrough=1', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-pt' }) });
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');

    expect(combined).toContain('event: raw\ndata: plain shell output');
    expect(combined).toContain('event: raw\ndata: more shell output');
  });

  it('parses JSON stream_event text_delta while passing raw lines through', async () => {
    const logFile = join(tempDir, 'pt-mixed.log');
    const textLine = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from claude"}}}';
    writeFileSync(logFile, 'shell line before\n' + textLine + '\nshell line after\n');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-pt-mix?passthrough=1', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-pt-mix' }) });
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');

    expect(combined).toContain('event: raw\ndata: shell line before');
    expect(combined).toContain('data: Hello from claude');
    expect(combined).toContain('event: raw\ndata: shell line after');
  });

  it('suppresses embedded result events and emits synthetic done once job is finished', async () => {
    const logFile = join(tempDir, 'pt-result.log');
    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s","result":"ok"}';
    writeFileSync(logFile, 'tests pass\n' + resultLine + '\n');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-pt-res?passthrough=1', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-pt-res' }) });
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');

    // Exactly one done event (synthetic), carrying the server exitCode — not the embedded result
    const doneMatches = combined.match(/event: done/g) || [];
    expect(doneMatches.length).toBe(1);
    expect(combined).toContain('"exitCode":0');
    // Result payload fields must NOT have leaked through
    expect(combined).not.toContain('"duration":1');
  });

  it('emits tool_use event when start and stop arrive in a single read', async () => {
    const logFile = join(tempDir, 'pt-tool.log');
    const toolStart = '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}}';
    const inputDelta = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}}';
    const toolStop = '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}';
    writeFileSync(logFile, toolStart + '\n' + inputDelta + '\n' + toolStop + '\n');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-pt-tool?passthrough=1', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-pt-tool' }) });
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');

    expect(combined).toContain('event: tool_use');
    expect(combined).toContain('"name":"Bash"');
    expect(combined).toContain('ls');
  });

  it('holds an incomplete trailing line across reads and flushes it on done', async () => {
    // Simulate partial-line write: content ends without a newline. The
    // passthrough handler must NOT split "partial-" and "line" into two
    // separate raw events; it buffers the tail and emits the full line
    // on done.
    const logFile = join(tempDir, 'pt-partial.log');
    writeFileSync(logFile, 'complete-line\npartial-line-no-newline');
    getJobMock.mockReturnValue({
      logPath: logFile,
      finishedAt: Date.now() / 1000,
      exitCode: 0,
    } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-pt-partial?passthrough=1', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-pt-partial' }) });
    const events = await collectClosedSSEStream(response);
    const combined = events.join('');

    expect(combined).toContain('event: raw\ndata: complete-line');
    expect(combined).toContain('event: raw\ndata: partial-line-no-newline');
  });
});

describe('GET /api/streaming/[jobId] – tool_result SSE event', () => {
  let tempDir: string;
  let getJobMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-streaming-tr-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getJobMock = vi.fn().mockReturnValue(null);
    getJobImpl = getJobMock;
    probeJobStatusImpl = vi.fn().mockResolvedValue('running');
  });

  it('emits tool_result SSE event from system subtype tool_result log line', async () => {
    const logFile = join(tempDir, 'sys-tr.log');
    const line = JSON.stringify({
      type: 'system',
      subtype: 'tool_result',
      content: 'tool output text',
    });
    writeFileSync(logFile, line + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-sys-tr', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-sys-tr' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: tool_result');
    expect(combined).toContain('tool output text');
  });

  it('emits tool_result SSE event from user message content block', async () => {
    const logFile = join(tempDir, 'user-tr.log');
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: 'user block tool output',
        }],
      },
    });
    writeFileSync(logFile, line + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-user-tr', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-user-tr' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    expect(combined).toContain('event: tool_result');
    expect(combined).toContain('user block tool output');
  });

  it('tool_result payload includes content field as JSON', async () => {
    const logFile = join(tempDir, 'tr-payload.log');
    const line = JSON.stringify({
      type: 'system',
      subtype: 'tool_result',
      content: 'payload content',
    });
    writeFileSync(logFile, line + '\n');
    getJobMock.mockReturnValue({ logPath: logFile, finishedAt: Date.now() / 1000, exitCode: 0 } as any);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/streaming/job-tr-payload', { signal: ac.signal });
    const response = await GET(req, { params: Promise.resolve({ jobId: 'job-tr-payload' }) });
    const events = await collectClosedSSEStream(response);

    const combined = events.join('');
    // The SSE data should be JSON with a "content" field
    const match = combined.match(/event: tool_result\ndata: (.+)/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload).toHaveProperty('content', 'payload content');
  });
});
