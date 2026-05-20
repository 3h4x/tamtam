#!/usr/bin/env node
/* eslint-env node */

/**
 * LM Studio-to-Claude CLI Shim
 *
 * TamTam invokes a Claude-compatible binary and expects either plain `--print`
 * output or Claude CLI `stream-json` NDJSON. This shim calls LM Studio's
 * native stateful chat API and translates the response into those shapes.
 */

const { installFetchInactivityWatchdog } = require('./shim-utils');

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';

const args = process.argv.slice(2);

let requestedModel = 'fast';
let outputFormat = 'text';
let promptArg = '';
let systemPrompt = '';
let resumeSessionId = '';
let cwd = '';

function consumeValue(index) {
  if (index + 1 >= args.length) return ['', index];
  return [args[index + 1], index + 1];
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    console.log(`Usage: lmstudio-shim.js [claude-args...]

Environment:
  LMSTUDIO_BASE_URL       LM Studio server URL (default: ${DEFAULT_BASE_URL})
  LMSTUDIO_MODEL          Default LM Studio model name
  LMSTUDIO_FAST_MODEL     Model used when TamTam asks for fast
  LMSTUDIO_NORMAL_MODEL   Model used when TamTam asks for normal
  LMSTUDIO_SMART_MODEL    Model used when TamTam asks for smart
  LMSTUDIO_HAIKU_MODEL    Legacy alias for LMSTUDIO_FAST_MODEL
  LMSTUDIO_SONNET_MODEL   Legacy alias for LMSTUDIO_NORMAL_MODEL
  LMSTUDIO_OPUS_MODEL     Legacy alias for LMSTUDIO_SMART_MODEL
  LMSTUDIO_API_KEY        Optional bearer token
  LMSTUDIO_TEMPERATURE    Optional numeric temperature
  LMSTUDIO_CONTEXT_LENGTH Optional native API context_length
`);
    process.exit(0);
  }

  if (arg === '--version' || arg === '-v') {
    console.log('lmstudio-shim 1.0.0');
    process.exit(0);
  }

  if (arg === '--model') {
    const [value, next] = consumeValue(i);
    if (value) requestedModel = value;
    i = next;
  } else if (arg.startsWith('--model=')) {
    requestedModel = arg.slice('--model='.length);
  } else if (arg === '--output-format') {
    const [value, next] = consumeValue(i);
    if (value) outputFormat = value;
    i = next;
  } else if (arg.startsWith('--output-format=')) {
    outputFormat = arg.slice('--output-format='.length);
  } else if (arg === '-p' || arg === '--prompt') {
    const [value, next] = consumeValue(i);
    promptArg = value;
    i = next;
  } else if (arg.startsWith('--prompt=')) {
    promptArg = arg.slice('--prompt='.length);
  } else if (arg === '--system-prompt') {
    const [value, next] = consumeValue(i);
    systemPrompt = value;
    i = next;
  } else if (arg.startsWith('--system-prompt=')) {
    systemPrompt = arg.slice('--system-prompt='.length);
  } else if (arg === '--cwd') {
    const [value, next] = consumeValue(i);
    cwd = value;
    i = next;
  } else if (arg.startsWith('--cwd=')) {
    cwd = arg.slice('--cwd='.length);
  } else if (arg === '--resume') {
    const [value, next] = consumeValue(i);
    resumeSessionId = value;
    i = next;
  } else if (arg.startsWith('--resume=')) {
    resumeSessionId = arg.slice('--resume='.length);
  } else if (
    arg === '--permission-mode' ||
    arg === '--allowed-tools' ||
    arg === '--tools'
  ) {
    const [, next] = consumeValue(i);
    i = next;
  }
}

if (cwd) {
  try {
    process.chdir(cwd);
  } catch (err) {
    fail(`cannot chdir to ${cwd}: ${err.message}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data));

    if (process.stdin.isTTY) resolve('');
  });
}

function resolveModel(model, env = process.env) {
  const byAlias = {
    fast: env.LMSTUDIO_FAST_MODEL || env.LMSTUDIO_HAIKU_MODEL,
    normal: env.LMSTUDIO_NORMAL_MODEL || env.LMSTUDIO_SONNET_MODEL,
    smart: env.LMSTUDIO_SMART_MODEL || env.LMSTUDIO_OPUS_MODEL,
    haiku: env.LMSTUDIO_FAST_MODEL || env.LMSTUDIO_HAIKU_MODEL,
    sonnet: env.LMSTUDIO_NORMAL_MODEL || env.LMSTUDIO_SONNET_MODEL,
    opus: env.LMSTUDIO_SMART_MODEL || env.LMSTUDIO_OPUS_MODEL,
  };
  return byAlias[model] || env.LMSTUDIO_MODEL || model;
}

function normalizeBaseUrl(value) {
  const trimmed = (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return trimmed
    .replace(/\/api\/v1$/, '')
    .replace(/\/v1$/, '');
}

function endpoint(baseUrl) {
  return `${baseUrl}/api/v1/chat`;
}

function emitJson(value) {
  console.log(JSON.stringify(value));
}

function emitResult({ model, durationMs, sessionId = '', inputTokens = 0, outputTokens = 0, error = false, result = '' }) {
  emitJson({
    type: 'result',
    subtype: error ? 'error' : 'success',
    is_error: error,
    duration_ms: durationMs,
    session_id: sessionId,
    result,
    modelUsage: {
      [model]: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  });
}

function makeTextEmitter(streamJson) {
  let started = false;

  return {
    write(text) {
      if (!text) return;
      if (!streamJson) {
        process.stdout.write(text);
        return;
      }
      if (!started) {
        emitJson({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'text', text: '' },
          },
        });
        started = true;
      }
      emitJson({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        },
      });
    },

    close() {
      if (streamJson && started) {
        emitJson({
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        });
      }
    },
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseSseEvents(chunk, state, onEvent) {
  state.pending += chunk;
  const frames = state.pending.split(/\r?\n\r?\n/);
  state.pending = frames.pop() || '';

  for (const frame of frames) {
    let event = '';
    const dataLines = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;
    const parsed = parseJsonLine(data);
    if (parsed) onEvent(event || parsed.type || '', parsed);
  }
}

function outputTextFromNativeResult(result) {
  const output = Array.isArray(result?.output) ? result.output : [];
  return output
    .filter((item) => item?.type === 'message' && typeof item.content === 'string')
    .map((item) => item.content)
    .join('');
}

async function callLmStudio({ prompt, model, streamJson, env = process.env, fetchImpl = fetch }) {
  const baseUrl = normalizeBaseUrl(env.LMSTUDIO_BASE_URL);

  const body = {
    model,
    input: prompt,
    stream: true,
    store: true,
  };

  if (systemPrompt.trim()) body.system_prompt = systemPrompt.trim();
  if (resumeSessionId && resumeSessionId.startsWith('resp_')) {
    body.previous_response_id = resumeSessionId;
  }
  if (env.LMSTUDIO_TEMPERATURE) {
    const temperature = Number(env.LMSTUDIO_TEMPERATURE);
    if (Number.isFinite(temperature)) body.temperature = temperature;
  }
  if (env.LMSTUDIO_CONTEXT_LENGTH) {
    const contextLength = Number(env.LMSTUDIO_CONTEXT_LENGTH);
    if (Number.isInteger(contextLength) && contextLength > 0) body.context_length = contextLength;
  }

  const headers = { 'content-type': 'application/json' };
  if (env.LMSTUDIO_API_KEY) {
    headers.authorization = `Bearer ${env.LMSTUDIO_API_KEY}`;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);

  const watchdog = installFetchInactivityWatchdog(abort, { shimName: 'lmstudio-shim' });
  const cleanup = () => {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    watchdog.dispose();
  };

  const startedAt = Date.now();
  const emitter = makeTextEmitter(streamJson);
  let fullText = '';
  let stats = null;
  let responseId = '';

  let response;
  try {
    try {
      response = await fetchImpl(endpoint(baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`LM Studio request failed at ${endpoint(baseUrl)}: ${err.message}`);
    }
    watchdog.markActivity();

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LM Studio HTTP ${response.status}${detail ? `: ${detail.slice(0, 1000)}` : ''}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      const json = await response.json();
      const text = outputTextFromNativeResult(json);
      stats = json?.stats || null;
      responseId = json?.response_id || '';
      emitter.write(text);
      fullText += text;
      emitter.close();
      return { fullText, stats, responseId, durationMs: Date.now() - startedAt };
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const sseState = { pending: '' };

    const onEvent = (eventName, data) => {
      const type = eventName || data?.type || '';
      if (type === 'message.delta') {
        const text = data?.content || '';
        if (text) {
          fullText += text;
          emitter.write(text);
        }
      } else if (type === 'reasoning.delta' && streamJson) {
        const thinking = data?.content || '';
        if (thinking) {
          emitJson({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'thinking_delta', thinking },
            },
          });
        }
      } else if (type === 'error') {
        throw new Error(data?.error?.message || 'LM Studio stream error');
      } else if (type === 'chat.end') {
        const result = data?.result || {};
        stats = result.stats || stats;
        responseId = result.response_id || responseId;
        if (!fullText) {
          const text = outputTextFromNativeResult(result);
          if (text) {
            fullText += text;
            emitter.write(text);
          }
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      watchdog.markActivity();
      parseSseEvents(decoder.decode(value, { stream: true }), sseState, onEvent);
    }
    parseSseEvents(`${decoder.decode()}\n\n`, sseState, onEvent);
    if (watchdog.timedOut()) {
      throw new Error('LM Studio request killed by inactivity watchdog');
    }

    if (resumeSessionId && !resumeSessionId.startsWith('resp_') && !responseId) {
      throw new Error(`cannot resume LM Studio session ${resumeSessionId}; expected an LM Studio response_id starting with "resp_"`);
    }

    emitter.close();
    return { fullText, stats, responseId: responseId || resumeSessionId, durationMs: Date.now() - startedAt };
  } finally {
    cleanup();
  }
}

function fail(message, streamJson = outputFormat === 'stream-json') {
  if (streamJson) {
    emitResult({
      model: resolveModel(requestedModel),
      durationMs: 0,
      sessionId: resumeSessionId,
      error: true,
      result: `[lmstudio-shim] ${message}`,
    });
  } else {
    console.error(`[lmstudio-shim] ${message}`);
  }
  process.exit(1);
}

if (require.main === module) (async () => {
  const stdinPrompt = await readStdin();
  const prompt = promptArg || stdinPrompt;
  const streamJson = outputFormat === 'stream-json';
  const model = resolveModel(requestedModel);

  if (!prompt.trim()) {
    fail('prompt is empty', streamJson);
  }

  try {
    const { fullText, stats, responseId, durationMs } = await callLmStudio({ prompt, model, streamJson });
    if (streamJson) {
      emitResult({
        model,
        durationMs,
        sessionId: responseId,
        inputTokens: stats?.input_tokens ?? estimateTokens(prompt),
        outputTokens: stats?.total_output_tokens ?? estimateTokens(fullText),
      });
    } else if (!fullText.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), streamJson);
  }
})();

module.exports = {
  callLmStudio,
  normalizeBaseUrl,
  parseSseEvents,
  resolveModel,
};
