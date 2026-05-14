import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { spawn } from 'child_process';
import { describe, it, expect } from 'vitest';

interface FakeServer {
  port: number;
  close: () => Promise<void>;
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

function startFakeServer(handler: RequestHandler): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

function runShim(
  baseUrl: string,
  shimArgs: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
  stdinContent = 'test prompt',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/lmstudio-shim.js', ...shimArgs], {
      cwd: process.cwd(),
      env: { ...process.env, LMSTUDIO_BASE_URL: baseUrl, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.stdin.end(stdinContent);
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function sseResponse(events: Array<{ event?: string; data: string }>): string {
  return events.map(({ event, data }) => {
    const lines = event ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
    return lines;
  }).join('') + 'data: [DONE]\n\n';
}

describe('lmstudio-shim model resolution', () => {
  it.concurrent('resolves fast tier to LMSTUDIO_FAST_MODEL', async () => {
    let capturedBody = '';
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          output: [{ type: 'message', content: 'ok' }],
          stats: { input_tokens: 5, total_output_tokens: 2 },
          response_id: 'resp_test',
        }));
      });
    });
    try {
      await runShim(`http://127.0.0.1:${srv.port}`, ['--model', 'fast', '--output-format', 'stream-json'], {
        LMSTUDIO_FAST_MODEL: 'llama-3.1-8b',
      });

      const body = JSON.parse(capturedBody);
      expect(body.model).toBe('llama-3.1-8b');
    } finally {
      await srv.close();
    }
  });

  it.concurrent('resolves smart tier to LMSTUDIO_SMART_MODEL', async () => {
    let capturedBody = '';
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: [{ type: 'message', content: 'done' }], stats: {} }));
      });
    });
    try {
      await runShim(`http://127.0.0.1:${srv.port}`, ['--model', 'smart', '--output-format', 'stream-json'], {
        LMSTUDIO_SMART_MODEL: 'llama-3.1-70b',
      });

      const body = JSON.parse(capturedBody);
      expect(body.model).toBe('llama-3.1-70b');
    } finally {
      await srv.close();
    }
  });

  it.concurrent('falls back to LMSTUDIO_MODEL for unknown tier names', async () => {
    let capturedBody = '';
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: [{ type: 'message', content: 'ok' }], stats: {} }));
      });
    });
    try {
      await runShim(`http://127.0.0.1:${srv.port}`, ['--model', 'someunknown', '--output-format', 'stream-json'], {
        LMSTUDIO_MODEL: 'my-custom-model',
      });

      const body = JSON.parse(capturedBody);
      expect(body.model).toBe('my-custom-model');
    } finally {
      await srv.close();
    }
  });

  it.concurrent('honours LMSTUDIO_OPUS_MODEL legacy alias for smart tier', async () => {
    let capturedBody = '';
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: [{ type: 'message', content: 'ok' }], stats: {} }));
      });
    });
    try {
      await runShim(`http://127.0.0.1:${srv.port}`, ['--model', 'opus', '--output-format', 'stream-json'], {
        LMSTUDIO_OPUS_MODEL: 'llama-3.1-70b-legacy',
      });

      const body = JSON.parse(capturedBody);
      expect(body.model).toBe('llama-3.1-70b-legacy');
    } finally {
      await srv.close();
    }
  });
});

describe('lmstudio-shim normalizeBaseUrl', () => {
  it.concurrent('strips /api/v1 suffix from the base URL', async () => {
    let reqPath = '';
    const srv = await startFakeServer((req, res) => {
      reqPath = req.url || '';
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: [{ type: 'message', content: 'ok' }], stats: {} }));
      });
    });
    try {
      await runShim(
        `http://127.0.0.1:${srv.port}/api/v1`,
        ['--output-format', 'stream-json'],
      );

      expect(reqPath).toBe('/api/v1/chat');
    } finally {
      await srv.close();
    }
  });

  it.concurrent('strips /v1 suffix from the base URL', async () => {
    let reqPath = '';
    const srv = await startFakeServer((req, res) => {
      reqPath = req.url || '';
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: [{ type: 'message', content: 'ok' }], stats: {} }));
      });
    });
    try {
      await runShim(
        `http://127.0.0.1:${srv.port}/v1`,
        ['--output-format', 'stream-json'],
      );

      expect(reqPath).toBe('/api/v1/chat');
    } finally {
      await srv.close();
    }
  });
});

describe('lmstudio-shim streaming (SSE)', () => {
  it.concurrent('emits text_delta events from SSE message.delta and a final result', async () => {
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = sseResponse([
          { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'Hello ' }) },
          { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'world' }) },
          {
            event: 'chat.end', data: JSON.stringify({
              type: 'chat.end',
              result: {
                response_id: 'resp_sse1',
                stats: { input_tokens: 10, total_output_tokens: 3 },
              },
            }),
          },
        ]);
        res.end(frames);
      });
    });
    try {
      const { code, stdout } = await runShim(
        `http://127.0.0.1:${srv.port}`,
        ['--model', 'normal', '--output-format', 'stream-json'],
      );

      expect(code).toBe(0);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const text = lines
        .filter((l) => l.type === 'stream_event' && l.event?.type === 'content_block_delta')
        .map((l) => l.event.delta.text)
        .join('');
      expect(text).toBe('Hello world');
      const result = lines.find((l) => l.type === 'result');
      expect(result?.is_error).toBe(false);
      expect(result?.session_id).toBe('resp_sse1');
    } finally {
      await srv.close();
    }
  });

  it.concurrent('emits plain text output when --output-format is not stream-json', async () => {
    const srv = await startFakeServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseResponse([
          { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'plain text' }) },
          { event: 'chat.end', data: JSON.stringify({ type: 'chat.end', result: { stats: {} } }) },
        ]));
      });
    });
    try {
      const { code, stdout } = await runShim(
        `http://127.0.0.1:${srv.port}`,
        ['--model', 'normal'],
      );

      expect(code).toBe(0);
      expect(stdout).toContain('plain text');
      expect(() => JSON.parse(stdout.trim())).toThrow();
    } finally {
      await srv.close();
    }
  });

  it.concurrent('emits error result on HTTP 4xx from LM Studio', async () => {
    const srv = await startFakeServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
      });
    });
    try {
      const { code, stdout } = await runShim(
        `http://127.0.0.1:${srv.port}`,
        ['--model', 'fast', '--output-format', 'stream-json'],
      );

      expect(code).toBe(1);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const result = lines.find((l) => l.type === 'result');
      expect(result?.is_error).toBe(true);
      expect(result?.result).toMatch(/429/);
    } finally {
      await srv.close();
    }
  });
});
