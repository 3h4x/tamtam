import { createRequire } from 'module';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const _require = createRequire(import.meta.url);
const shim = _require(join(process.cwd(), 'scripts/lmstudio-shim.js')) as {
  callLmStudio: (args: {
    prompt: string;
    model: string;
    streamJson: boolean;
    env?: Partial<NodeJS.ProcessEnv>;
    fetchImpl?: typeof fetch;
  }) => Promise<{ fullText: string; stats: unknown; responseId: string; durationMs: number }>;
  normalizeBaseUrl: (value?: string) => string;
  resolveModel: (model: string, env?: Partial<NodeJS.ProcessEnv>) => string;
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function captureOutput<T>(fn: () => Promise<T>): Promise<{ output: string; result: T }> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write');
  write.mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    chunks.push(`${String(line ?? '')}\n`);
  });

  return fn().then((result) => ({ output: chunks.join(''), result }));
}

function jsonFetch(payload: unknown, requests: CapturedRequest[]): typeof fetch {
  return vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const rawHeaders = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers as Record<string, string> | undefined) ?? {};
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: rawHeaders,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function loadShimWithArgs(args: string[]) {
  const resolved = _require.resolve(join(process.cwd(), 'scripts/lmstudio-shim.js'));
  const originalArgv = process.argv;
  delete _require.cache[resolved];
  process.argv = [process.execPath, resolved, ...args];
  try {
    return _require(resolved) as typeof shim;
  } finally {
    process.argv = originalArgv;
    delete _require.cache[resolved];
  }
}

function sseResponse(events: Array<{ event?: string; data: string }>): string {
  return events.map(({ event, data }) => {
    return event ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
  }).join('') + 'data: [DONE]\n\n';
}

function sseFetch(events: Array<{ event?: string; data: string }>): typeof fetch {
  return vi.fn(async () => new Response(sseResponse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch;
}

describe('lmstudio-shim model resolution', () => {
  it('resolves fast tier to LMSTUDIO_FAST_MODEL', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: shim.resolveModel('fast', { LMSTUDIO_FAST_MODEL: 'llama-3.1-8b' }),
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test', LMSTUDIO_FAST_MODEL: 'llama-3.1-8b' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body.model).toBe('llama-3.1-8b');
  });

  it('resolves smart tier to LMSTUDIO_SMART_MODEL', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: shim.resolveModel('smart', { LMSTUDIO_SMART_MODEL: 'llama-3.1-70b' }),
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test', LMSTUDIO_SMART_MODEL: 'llama-3.1-70b' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'done' }], stats: {} }, requests),
    }));

    expect(requests[0].body.model).toBe('llama-3.1-70b');
  });

  it('falls back to LMSTUDIO_MODEL for unknown tier names', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: shim.resolveModel('someunknown', { LMSTUDIO_MODEL: 'my-custom-model' }),
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test', LMSTUDIO_MODEL: 'my-custom-model' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body.model).toBe('my-custom-model');
  });

  it('honours LMSTUDIO_OPUS_MODEL legacy alias for smart tier', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: shim.resolveModel('opus', { LMSTUDIO_OPUS_MODEL: 'llama-3.1-70b-legacy' }),
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test', LMSTUDIO_OPUS_MODEL: 'llama-3.1-70b-legacy' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body.model).toBe('llama-3.1-70b-legacy');
  });
});

describe('lmstudio-shim normalizeBaseUrl', () => {
  it('strips /api/v1 suffix from the base URL', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'fast',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test/api/v1' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].url).toBe('http://lmstudio.test/api/v1/chat');
  });

  it('strips /v1 suffix from the base URL', async () => {
    const requests: CapturedRequest[] = [];
    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'fast',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test/v1' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].url).toBe('http://lmstudio.test/api/v1/chat');
  });
});

describe('lmstudio-shim request payload', () => {
  it('forwards system prompt and LM Studio resume ids from CLI args', async () => {
    const requests: CapturedRequest[] = [];
    const shimWithArgs = loadShimWithArgs([
      '--system-prompt',
      '  keep this system prompt  ',
      '--resume',
      'resp_existing',
    ]);

    await captureOutput(() => shimWithArgs.callLmStudio({
      prompt: 'test prompt',
      model: 'normal',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body.system_prompt).toBe('keep this system prompt');
    expect(requests[0].body.previous_response_id).toBe('resp_existing');
  });

  it('includes supported native tuning fields and auth header from env', async () => {
    const requests: CapturedRequest[] = [];

    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'normal',
      streamJson: true,
      env: {
        LMSTUDIO_BASE_URL: 'http://lmstudio.test',
        LMSTUDIO_TEMPERATURE: '0.7',
        LMSTUDIO_CONTEXT_LENGTH: '8192',
        LMSTUDIO_API_KEY: 'secret-token',
      },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body.temperature).toBe(0.7);
    expect(requests[0].body.context_length).toBe(8192);
    expect(requests[0].headers.authorization).toBe('Bearer secret-token');
  });

  it('ignores invalid LM Studio native tuning env values', async () => {
    const requests: CapturedRequest[] = [];

    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'normal',
      streamJson: true,
      env: {
        LMSTUDIO_BASE_URL: 'http://lmstudio.test',
        LMSTUDIO_TEMPERATURE: 'not-a-number',
        LMSTUDIO_CONTEXT_LENGTH: '0',
      },
      fetchImpl: jsonFetch({ output: [{ type: 'message', content: 'ok' }], stats: {} }, requests),
    }));

    expect(requests[0].body).not.toHaveProperty('temperature');
    expect(requests[0].body).not.toHaveProperty('context_length');
  });
});

describe('lmstudio-shim streaming (SSE)', () => {
  it('emits text_delta events from SSE message.delta and a final result', async () => {
    const { output, result } = await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'normal',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl: sseFetch([
        { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'Hello ' }) },
        { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'world' }) },
        {
          event: 'chat.end',
          data: JSON.stringify({
            type: 'chat.end',
            result: {
              response_id: 'resp_sse1',
              stats: { input_tokens: 10, total_output_tokens: 3 },
            },
          }),
        },
      ]),
    }));

    const lines = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const text = lines
      .filter((line) => line.type === 'stream_event' && line.event?.type === 'content_block_delta')
      .map((line) => line.event.delta.text)
      .join('');
    expect(text).toBe('Hello world');
    expect(result.responseId).toBe('resp_sse1');
  });

  it('emits plain text output when --output-format is not stream-json', async () => {
    const { output } = await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'normal',
      streamJson: false,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl: sseFetch([
        { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'plain text' }) },
        { event: 'chat.end', data: JSON.stringify({ type: 'chat.end', result: { stats: {} } }) },
      ]),
    }));

    expect(output).toContain('plain text');
    expect(() => JSON.parse(output.trim())).toThrow();
  });

  it('throws on HTTP 4xx from LM Studio', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    await expect(shim.callLmStudio({
      prompt: 'test prompt',
      model: 'fast',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl,
    })).rejects.toThrow(/LM Studio HTTP 429/);
  });

  it('removes process signal listeners after a successful request', async () => {
    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeSigint = process.listenerCount('SIGINT');

    await captureOutput(() => shim.callLmStudio({
      prompt: 'test prompt',
      model: 'fast',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl: sseFetch([
        { event: 'message.delta', data: JSON.stringify({ type: 'message.delta', content: 'ok' }) },
        { event: 'chat.end', data: JSON.stringify({ type: 'chat.end', result: { stats: {} } }) },
      ]),
    }));

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
  });

  it('removes process signal listeners after a failed request', async () => {
    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeSigint = process.listenerCount('SIGINT');
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(shim.callLmStudio({
      prompt: 'test prompt',
      model: 'fast',
      streamJson: true,
      env: { LMSTUDIO_BASE_URL: 'http://lmstudio.test' },
      fetchImpl,
    })).rejects.toThrow(/network down/);

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
  });
});
