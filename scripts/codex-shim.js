#!/usr/bin/env node
/* eslint-env node */

/**
 * Codex-to-Claude CLI Shim
 *
 * TamTam invokes a Claude-compatible CLI. This wrapper launches `codex exec`
 * and translates its JSONL event stream into the Claude `stream-json` shape
 * that TamTam already parses.
 */

const { spawn } = require('child_process');
const { installInactivityWatchdog } = require('./shim-utils');

const args = process.argv.slice(2);

let requestedModel = 'fast';
let outputFormat = 'text';
let promptArg = '';
let cwd = '';
let permissionMode = 'bypassPermissions';
let resumeSessionId = '';

function consumeValue(index) {
  if (index + 1 >= args.length) return ['', index];
  return [args[index + 1], index + 1];
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log(`Usage: codex-shim.js [claude-args...]

Environment:
  CODEX_BIN            Codex executable (default: codex)
  CODEX_MODEL          Default Codex model
  CODEX_FAST_MODEL     Model used when TamTam asks for fast (default: gpt-5.4-mini)
  CODEX_NORMAL_MODEL   Model used when TamTam asks for normal (default: gpt-5.4)
  CODEX_SMART_MODEL    Model used when TamTam asks for smart (default: gpt-5.5)
  CODEX_HAIKU_MODEL    Legacy alias for CODEX_FAST_MODEL
  CODEX_SONNET_MODEL   Legacy alias for CODEX_NORMAL_MODEL
  CODEX_OPUS_MODEL     Legacy alias for CODEX_SMART_MODEL

Permission mode mapping:
  bypassPermissions -> --dangerously-bypass-approvals-and-sandbox
  dontAsk           -> --ask-for-approval never --sandbox workspace-write
  auto              -> --ask-for-approval never --sandbox workspace-write
  acceptEdits       -> --ask-for-approval on-request --sandbox workspace-write
  default           -> --ask-for-approval on-request --sandbox workspace-write
  plan              -> --ask-for-approval on-request --sandbox read-only
`);
    process.exit(0);
  }

  if (arg === '--version' || arg === '-v') {
    console.log('codex-shim 1.0.0');
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
  } else if (arg === '--cwd') {
    const [value, next] = consumeValue(i);
    cwd = value;
    i = next;
  } else if (arg.startsWith('--cwd=')) {
    cwd = arg.slice('--cwd='.length);
  } else if (arg === '--permission-mode') {
    const [value, next] = consumeValue(i);
    if (value) permissionMode = value;
    i = next;
  } else if (arg.startsWith('--permission-mode=')) {
    permissionMode = arg.slice('--permission-mode='.length);
  } else if (arg === '--resume') {
    const [value, next] = consumeValue(i);
    resumeSessionId = value;
    i = next;
  } else if (arg.startsWith('--resume=')) {
    resumeSessionId = arg.slice('--resume='.length);
  } else if (
    arg === '--allowed-tools' ||
    arg === '--tools' ||
    arg === '--system-prompt'
  ) {
    const [, next] = consumeValue(i);
    i = next;
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

function resolveModel(model) {
  const byAlias = {
    fast: process.env.CODEX_FAST_MODEL || process.env.CODEX_HAIKU_MODEL || 'gpt-5.4-mini',
    normal: process.env.CODEX_NORMAL_MODEL || process.env.CODEX_SONNET_MODEL || 'gpt-5.4',
    smart: process.env.CODEX_SMART_MODEL || process.env.CODEX_OPUS_MODEL || 'gpt-5.5',
    haiku: process.env.CODEX_FAST_MODEL || process.env.CODEX_HAIKU_MODEL || 'gpt-5.4-mini',
    sonnet: process.env.CODEX_NORMAL_MODEL || process.env.CODEX_SONNET_MODEL || 'gpt-5.4',
    opus: process.env.CODEX_SMART_MODEL || process.env.CODEX_OPUS_MODEL || 'gpt-5.5',
  };
  return byAlias[model] || process.env.CODEX_MODEL || model;
}

function sandboxFor(mode) {
  if (mode === 'plan') return 'read-only';
  return 'workspace-write';
}

function approvalFor(mode) {
  if (mode === 'plan' || mode === 'default' || mode === 'acceptEdits') return 'on-request';
  return 'never';
}

function permissionArgsFor(mode) {
  if (mode === 'bypassPermissions') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return ['-a', approvalFor(mode), '--sandbox', sandboxFor(mode)];
}

function emitJson(value) {
  console.log(JSON.stringify(value));
}

function emitResult({ model, durationMs, sessionId = '', inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, error = false, result = '' }) {
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
        cacheReadInputTokens,
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
        emitJson({ type: 'stream_event', event: { type: 'content_block_stop' } });
      }
      started = false;
    },
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function errorResultText({ code, signal, stderr, fullText }) {
  const trimmedStderr = stderr.trim();
  if (trimmedStderr) return trimmedStderr;
  const trimmedText = fullText.trim();
  if (trimmedText) {
    return `[codex-shim] codex exited ${code ?? `via ${signal || 'unknown signal'}`} after assistant output with no stderr`;
  }
  return `[codex-shim] codex exited ${code ?? `via ${signal || 'unknown signal'}`} with no stderr or assistant output`;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textFromEvent(event) {
  if (typeof event.message === 'string') return event.message;
  if (typeof event.text === 'string') return event.text;
  if (typeof event.delta === 'string') return event.delta;
  if (typeof event.content === 'string') return event.content;
  if (Array.isArray(event.content)) {
    return event.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .join('');
  }
  if (event.payload) return textFromEvent(event.payload);
  return '';
}

function unwrapCodexEvent(event) {
  if (
    event &&
    (event.type === 'event_msg' || event.type === 'response_item') &&
    event.payload &&
    typeof event.payload === 'object'
  ) {
    return event.payload;
  }
  return event;
}

function usageFromTokenCount(event) {
  const directUsage = event?.usage || event?.payload?.usage;
  if (directUsage) {
    const cachedInputTokens = directUsage.cached_input_tokens || 0;
    const inputTokens = directUsage.input_tokens || 0;
    return {
      inputTokens: Math.max(0, inputTokens - cachedInputTokens),
      outputTokens: directUsage.output_tokens || 0,
      cacheReadInputTokens: cachedInputTokens,
    };
  }
  const info = event?.info || event?.payload?.info || {};
  const usage = info.last_token_usage || info.total_token_usage || {};
  const cachedInputTokens = usage.cached_input_tokens || 0;
  const inputTokens = usage.input_tokens || 0;
  return {
    inputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: usage.output_tokens || 0,
    cacheReadInputTokens: cachedInputTokens,
  };
}

function sessionFromEvent(event) {
  return event?.session_id || event?.thread_id || event?.id || event?.payload?.session_id || event?.payload?.thread_id || event?.payload?.id || '';
}

function textFromCompletedItem(event) {
  const item = event?.item || event?.payload?.item;
  if (!item || typeof item !== 'object') return '';
  if (
    item.type === 'agent_message' ||
    item.type === 'assistant_message' ||
    item.type === 'message'
  ) {
    if (item.role && item.role !== 'assistant') return '';
    return textFromEvent(item);
  }
  return '';
}

function shouldEmitText(text, emittedTexts) {
  if (!text) return false;
  const key = text.trim();
  if (!key) return false;
  if (emittedTexts.has(key)) return false;
  emittedTexts.add(key);
  return true;
}

function launchCodex({ prompt, model, streamJson }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const codexBin = process.env.CODEX_BIN || 'codex';
    const codexArgs = [
      ...permissionArgsFor(permissionMode),
      'exec',
    ];
    if (resumeSessionId && streamJson) {
      codexArgs.push('resume', '--model', model, '--skip-git-repo-check');
      if (streamJson) codexArgs.push('--json');
      codexArgs.push(resumeSessionId, '-');
    } else {
      codexArgs.push('--model', model, '--color', 'never', '--skip-git-repo-check');
      if (streamJson) codexArgs.push('--json');
      codexArgs.push('-');
    }

    let child;
    let signalled = false;

    function forwardSignal(sig) {
      if (signalled) return;
      signalled = true;
      try { if (child) child.kill(sig); } catch { /* child may have already exited */ }
    }

    const onSigterm = () => forwardSignal('SIGTERM');
    const onSigint = () => forwardSignal('SIGINT');
    const onSighup = () => forwardSignal('SIGHUP');
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    process.on('SIGHUP', onSighup);

    function removeSignalHandlers() {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
      process.off('SIGHUP', onSighup);
    }

    child = spawn(codexBin, codexArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const watchdog = installInactivityWatchdog(child, { shimName: 'codex-shim' });
    const emitter = makeTextEmitter(streamJson);
    let stdoutBuffer = '';
    let stderr = '';
    let fullText = '';
    let usage = { inputTokens: estimateTokens(prompt), outputTokens: 0, cacheReadInputTokens: 0 };
    let sessionId = resumeSessionId;
    const emittedTexts = new Set();

    child.stdin.end(prompt);

    const handleLine = (line) => {
      if (!line.trim()) return;
      const event = parseJsonLine(line);
      if (!event) {
        fullText += `${line}\n`;
        emitter.write(`${line}\n`);
        return;
      }
      const payload = unwrapCodexEvent(event);
      const type = payload?.type || event.type || '';
      sessionId = sessionFromEvent(payload) || sessionFromEvent(event) || sessionId;
      if (type === 'token_count' || type === 'turn.completed') {
        usage = usageFromTokenCount(payload);
        return;
      }
      if (
        type === 'agent_message' ||
        type === 'assistant_message' ||
        type === 'message' ||
        type === 'response.output_text.delta' ||
        type === 'output_text_delta'
      ) {
        if (event.type === 'response_item' && type === 'message' && payload?.role !== 'assistant') return;
        const text = textFromEvent(payload);
        if (!shouldEmitText(text, emittedTexts)) return;
        fullText += text;
        emitter.write(text);
      } else if (type === 'item.completed') {
        const text = textFromCompletedItem(event);
        if (!shouldEmitText(text, emittedTexts)) return;
        fullText += text;
        emitter.write(text);
      } else if (type === 'task_complete') {
        const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
        if (!shouldEmitText(text, emittedTexts)) return;
        fullText += text;
        emitter.write(text);
      } else if (type === 'error') {
        const message = textFromEvent(payload) || payload.error?.message || event.error?.message || 'Codex error';
        fullText += message;
        emitter.write(message);
      }
    };

    child.stdout.on('data', (chunk) => {
      watchdog.markActivity();
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk) => {
      watchdog.markActivity();
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      removeSignalHandlers();
      watchdog.dispose();
      reject(err);
    });
    child.on('close', (code, signal) => {
      removeSignalHandlers();
      watchdog.dispose();
      if (watchdog.timedOut() && !stderr.trim()) {
        stderr = `[codex-shim] killed by inactivity watchdog after ${process.env.SHIM_INACTIVITY_TIMEOUT_MS || 600000}ms with no output from child`;
      }
      if (stdoutBuffer) handleLine(stdoutBuffer);
      emitter.close();
      if (!streamJson && fullText && !fullText.endsWith('\n')) process.stdout.write('\n');
      if (streamJson) {
        const noAssistantOutput = code === 0 && !fullText.trim();
        emitResult({
          model,
          durationMs: Date.now() - startedAt,
          sessionId,
          inputTokens: usage.inputTokens || estimateTokens(prompt),
          outputTokens: usage.outputTokens || estimateTokens(fullText),
          cacheReadInputTokens: usage.cacheReadInputTokens || 0,
          error: code !== 0 || noAssistantOutput,
          result: code === 0
            ? (noAssistantOutput ? '[codex-shim] codex produced no assistant output' : '')
            : errorResultText({ code, signal, stderr, fullText }),
        });
      } else if (code !== 0 && stderr.trim()) {
        process.stderr.write(stderr);
      }
      const signalExitCode = signal ? 128 + (require('os').constants.signals[signal] || 0) : 1;
      resolve((code === 0 && streamJson && !fullText.trim()) ? 1 : (code ?? signalExitCode));
    });
  });
}

(async () => {
  const stdinPrompt = await readStdin();
  const prompt = promptArg || stdinPrompt;
  const streamJson = outputFormat === 'stream-json';
  const model = resolveModel(requestedModel);

  if (!prompt.trim()) {
    if (streamJson) emitResult({ model, durationMs: 0, error: true, result: '[codex-shim] prompt is empty' });
    else console.error('[codex-shim] prompt is empty');
    process.exit(1);
  }

  try {
    const code = await launchCodex({ prompt, model, streamJson });
    process.exit(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (streamJson) emitResult({ model, durationMs: 0, error: true, result: `[codex-shim] ${message}` });
    else console.error(`[codex-shim] ${message}`);
    process.exit(1);
  }
})();
