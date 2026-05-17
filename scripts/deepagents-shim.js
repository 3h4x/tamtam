#!/usr/bin/env node
/* eslint-env node */

/**
 * Deep Agents Code-to-Claude CLI Shim
 *
 * TamTam invokes a Claude-compatible binary and expects either plain text or
 * Claude CLI `stream-json` NDJSON. This shim launches the Deep Agents Code
 * CLI (`dcode`) in non-interactive mode and frames its output for TamTam's
 * stream parser.
 */

const { spawn } = require('child_process');
const { installInactivityWatchdog } = require('./shim-utils');

const args = process.argv.slice(2);

let requestedModel = 'fast';
let outputFormat = 'text';
let promptArg = '';
let systemPrompt = '';
let resumeSessionId = '';
let cwd = '';
let permissionMode = '';

function consumeValue(index) {
  if (index + 1 >= args.length) return ['', index];
  return [args[index + 1], index + 1];
}

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    console.log(`Usage: deepagents-shim.js [claude-args...]

Environment:
  DEEPAGENTS_BIN               dcode executable (default: dcode)
  DEEPAGENTS_BACKEND           lmstudio | ollama (default: lmstudio)
  DEEPAGENTS_BASE_URL          Backend base URL override
  DEEPAGENTS_MODEL             Default backend model name
  DEEPAGENTS_FAST_MODEL        Model used when TamTam asks for fast
  DEEPAGENTS_NORMAL_MODEL      Model used when TamTam asks for normal
  DEEPAGENTS_SMART_MODEL       Model used when TamTam asks for smart
  DEEPAGENTS_SHELL_ALLOW_LIST  Shell allow-list for non-interactive runs
`);
    process.exit(0);
  }

  if (arg === '--version' || arg === '-v') {
    console.log('deepagents-shim 1.0.0');
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
  } else if (arg === '--permission-mode') {
    const [value, next] = consumeValue(i);
    permissionMode = value;
    i = next;
  } else if (arg === '--allowed-tools' || arg === '--tools') {
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

function normalizeBackend(value) {
  return value === 'ollama' ? 'ollama' : 'lmstudio';
}

function normalizeBaseUrl(value, backend) {
  const fallback = backend === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234';
  const trimmed = (value || fallback).replace(/\/+$/, '');
  if (backend === 'lmstudio') {
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }
  return trimmed;
}

function resolveModel(model) {
  const byAlias = {
    fast: process.env.DEEPAGENTS_FAST_MODEL || process.env.DEEPAGENTS_HAIKU_MODEL,
    normal: process.env.DEEPAGENTS_NORMAL_MODEL || process.env.DEEPAGENTS_SONNET_MODEL,
    smart: process.env.DEEPAGENTS_SMART_MODEL || process.env.DEEPAGENTS_OPUS_MODEL,
    haiku: process.env.DEEPAGENTS_FAST_MODEL || process.env.DEEPAGENTS_HAIKU_MODEL,
    sonnet: process.env.DEEPAGENTS_NORMAL_MODEL || process.env.DEEPAGENTS_SONNET_MODEL,
    opus: process.env.DEEPAGENTS_SMART_MODEL || process.env.DEEPAGENTS_OPUS_MODEL,
  };
  return byAlias[model] || process.env.DEEPAGENTS_MODEL || model;
}

function modelArg(backend, model) {
  if (/^(openai|ollama|anthropic|google|gemini):/.test(model)) return model;
  return `${backend === 'ollama' ? 'ollama' : 'openai'}:${model}`;
}

function emitJson(value) {
  console.log(JSON.stringify(value));
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
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
  let text = '';

  return {
    write(chunk) {
      if (!chunk) return;
      text += chunk;
      if (!streamJson) {
        process.stdout.write(chunk);
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
          delta: { type: 'text_delta', text: chunk },
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
      return text;
    },
  };
}

function shellAllowList(mode) {
  if (process.env.DEEPAGENTS_SHELL_ALLOW_LIST) return process.env.DEEPAGENTS_SHELL_ALLOW_LIST;
  if (mode === 'bypassPermissions') return 'all';
  if (mode === 'plan') return '';
  return 'recommended';
}

function buildDeepAgentsArgs(prompt, model) {
  const out = ['--model', model, '-q', '-n', prompt];
  if (resumeSessionId) out.unshift('--resume', resumeSessionId);
  if (permissionMode !== 'plan') out.unshift('--auto-approve');
  const allowList = shellAllowList(permissionMode);
  if (allowList) out.push('-S', allowList);
  if (process.env.DEEPAGENTS_NO_STREAM === '1') out.push('--no-stream');
  return out;
}

async function runDeepAgents({ prompt, streamJson }) {
  const backend = normalizeBackend(process.env.DEEPAGENTS_BACKEND);
  const model = resolveModel(requestedModel);
  const fullModel = modelArg(backend, model);
  const env = { ...process.env };

  if (backend === 'lmstudio') {
    env.OPENAI_API_KEY = env.OPENAI_API_KEY || 'lm-studio';
    env.OPENAI_BASE_URL = normalizeBaseUrl(process.env.DEEPAGENTS_BASE_URL || process.env.LMSTUDIO_BASE_URL, backend);
    env.DEEPAGENTS_CODE_OPENAI_API_KEY = env.DEEPAGENTS_CODE_OPENAI_API_KEY || env.OPENAI_API_KEY;
  } else {
    env.OLLAMA_HOST = normalizeBaseUrl(process.env.DEEPAGENTS_BASE_URL || process.env.OLLAMA_BASE_URL, backend);
  }

  const startedAt = Date.now();
  const child = spawn(process.env.DEEPAGENTS_BIN || 'dcode', buildDeepAgentsArgs(prompt, fullModel), {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const watchdog = installInactivityWatchdog(child, { shimName: 'deepagents-shim' });
  const emitter = makeTextEmitter(streamJson);
  let stderr = '';

  if (streamJson) {
    emitJson({ type: 'system', subtype: 'init', backend, model: fullModel });
  }

  child.stdout.on('data', (chunk) => {
    watchdog.markActivity();
    emitter.write(chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    watchdog.markActivity();
    stderr += chunk.toString();
  });

  const exit = await new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: 1, signal: null, error: err }));
    child.on('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  watchdog.dispose();

  const fullText = emitter.close();
  const durationMs = Date.now() - startedAt;
  if (watchdog.timedOut()) {
    throw new Error('deepagents request killed by inactivity watchdog');
  }
  if (exit.error) {
    throw exit.error;
  }
  if (exit.code !== 0) {
    const suffix = stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : '';
    throw new Error(`deepagents exited ${exit.code ?? `via ${exit.signal || 'unknown signal'}`}${suffix}`);
  }
  return { fullText, model: fullModel, durationMs };
}

function fail(message, streamJson = outputFormat === 'stream-json') {
  const backend = normalizeBackend(process.env.DEEPAGENTS_BACKEND);
  const model = modelArg(backend, resolveModel(requestedModel));
  if (streamJson) {
    emitResult({
      model,
      durationMs: 0,
      sessionId: resumeSessionId,
      error: true,
      result: `[deepagents-shim] ${message}`,
    });
  } else {
    console.error(`[deepagents-shim] ${message}`);
  }
  process.exit(1);
}

(async () => {
  const stdinPrompt = await readStdin();
  const rawPrompt = promptArg || stdinPrompt;
  const prompt = systemPrompt.trim()
    ? `${systemPrompt.trim()}\n\n${rawPrompt}`
    : rawPrompt;
  const streamJson = outputFormat === 'stream-json';

  if (!prompt.trim()) {
    fail('prompt is empty', streamJson);
  }

  try {
    const { fullText, model, durationMs } = await runDeepAgents({ prompt, streamJson });
    if (streamJson) {
      emitJson({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: fullText }],
        },
      });
      emitResult({
        model,
        durationMs,
        sessionId: resumeSessionId,
        inputTokens: estimateTokens(prompt),
        outputTokens: estimateTokens(fullText),
      });
    } else if (!fullText.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), streamJson);
  }
})();
