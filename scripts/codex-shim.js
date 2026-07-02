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
const { installInactivityWatchdog, installSignalForwarding, isBrokenPipeError } = require('./shim-utils');

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
  acceptEdits       -> --ask-for-approval never --sandbox workspace-write
  default           -> --ask-for-approval never --sandbox workspace-write
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

function resolveModel(model, env) {
  const e = env || process.env;
  const byAlias = {
    fast: e.CODEX_FAST_MODEL || e.CODEX_HAIKU_MODEL || 'gpt-5.4-mini',
    normal: e.CODEX_NORMAL_MODEL || e.CODEX_SONNET_MODEL || 'gpt-5.4',
    smart: e.CODEX_SMART_MODEL || e.CODEX_OPUS_MODEL || 'gpt-5.5',
    haiku: e.CODEX_FAST_MODEL || e.CODEX_HAIKU_MODEL || 'gpt-5.4-mini',
    sonnet: e.CODEX_NORMAL_MODEL || e.CODEX_SONNET_MODEL || 'gpt-5.4',
    opus: e.CODEX_SMART_MODEL || e.CODEX_OPUS_MODEL || 'gpt-5.5',
  };
  return byAlias[model] || e.CODEX_MODEL || model;
}

function sandboxFor(mode) {
  if (mode === 'plan') return 'read-only';
  return 'workspace-write';
}

function approvalFor(mode) {
  if (mode === 'plan') return 'on-request';
  return 'never';
}

// TamTam writes the selected broker MCP endpoint into TAMTAM_BROKER_MCP_URL
// when the per-run MCP config is being injected. Codex doesn't have a
// `--mcp-config <file>` flag — it reads from $CODEX_HOME/config.toml or
// `-c <key>=<value>` overrides. Using `-c` keeps the user's normal CODEX_HOME
// (auth + sessions) intact and just appends the broker MCP server inline.
function brokerConfigFlags(env) {
  const e = env || process.env;
  const mcpUrl = e.TAMTAM_BROKER_MCP_URL || (e.TAMTAM_BROKER_URL ? `${e.TAMTAM_BROKER_URL}/mcp` : '');
  if (!mcpUrl) return [];
  const flags = [
    '-c', `mcp_servers.tamtam_browser.url="${mcpUrl}"`,
  ];
  if (mcpUrl.endsWith('/sse')) {
    flags.push('-c', 'mcp_servers.tamtam_browser.transport="sse"');
  }
  return flags;
}

function brokerMcpUrlFor(env) {
  const e = env || process.env;
  return e.TAMTAM_BROKER_MCP_URL || (e.TAMTAM_BROKER_URL ? `${e.TAMTAM_BROKER_URL}/mcp` : '');
}

function permissionArgsFor(mode, env) {
  if (mode === 'bypassPermissions') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  if (mode === 'plan') {
    return ['-a', approvalFor(mode), '--sandbox', sandboxFor(mode)];
  }
  // When TamTam wraps the shim in `sandbox-exec`, the outer seatbelt profile
  // is the real sandbox. Codex's built-in workspace-write profile would
  // double-sandbox AND block loopback (which the broker needs). Tell codex
  // to skip its own sandbox; the outer profile keeps the real restrictions.
  const e = env || process.env;
  // Codex 0.128.0 rejects MCP tool calls under `workspace-write` with
  // `user cancelled MCP tool call`, regardless of approvals_reviewer or
  // per-server approval_mode. `danger-full-access` is the only sandbox
  // policy that lets write-capable agent modes reach the loopback broker.
  // `plan` is handled above so it keeps its read-only sandbox contract.
  // When the outer seatbelt is the real sandbox (TAMTAM_SANDBOX_PROFILE)
  // OR the broker is being injected for this run, promote to danger-full-access.
  if (e.TAMTAM_SANDBOX_PROFILE || brokerMcpUrlFor(e)) {
    return ['-a', approvalFor(mode), '--sandbox', 'danger-full-access'];
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

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function addUsageTotals(total, current) {
  return {
    inputTokens: total.inputTokens + (current.inputTokens || 0),
    outputTokens: total.outputTokens + (current.outputTokens || 0),
    cacheReadInputTokens: total.cacheReadInputTokens + (current.cacheReadInputTokens || 0),
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

const CODEX_WRAPPER_EVENT_TYPES = new Set(['event_msg', 'response_item']);
const CODEX_TOP_LEVEL_EVENT_TYPES = new Set([
  'session_meta',
  'thread.started',
  'turn.started',
  'turn.completed',
  'item.completed',
]);
const CODEX_PAYLOAD_EVENT_TYPES = new Set([
  'agent_message',
  'assistant_message',
  'message',
  'response.output_text.delta',
  'output_text_delta',
  'task_complete',
  'token_count',
  'error',
]);

const CODEX_NAMESPACE_PREFIXES = ['item.', 'turn.', 'thread.', 'response.', 'session.'];

function hasCodexNamespacePrefix(value) {
  if (typeof value !== 'string') return false;
  for (const prefix of CODEX_NAMESPACE_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

function isCodexEvent(event, payload, type) {
  if (!event || typeof event !== 'object') return false;
  if (CODEX_WRAPPER_EVENT_TYPES.has(event.type)) {
    return Boolean(event.payload && typeof event.payload === 'object');
  }
  if (CODEX_TOP_LEVEL_EVENT_TYPES.has(event.type)) return true;
  if (hasCodexNamespacePrefix(event.type) || hasCodexNamespacePrefix(type)) return true;
  if (event.item && typeof event.item === 'object' && event.type === 'item.completed') return true;
  if (event.usage && typeof event.usage === 'object' && event.type === 'turn.completed') return true;
  if (CODEX_PAYLOAD_EVENT_TYPES.has(type)) {
    return Boolean(
      event.payload ||
      event.item ||
      event.usage ||
      event.info ||
      event.message ||
      event.text ||
      event.delta ||
      event.content ||
      event.error ||
      payload?.last_agent_message
    );
  }
  return typeof event.thread_id === 'string' ||
    typeof event.session_id === 'string' ||
    typeof payload?.thread_id === 'string' ||
    typeof payload?.session_id === 'string';
}

function shouldEmitText(text, emittedTexts) {
  if (!text) return false;
  const key = text.trim();
  if (!key) return false;
  if (emittedTexts.has(key)) return false;
  emittedTexts.add(key);
  return true;
}

function isDeltaEventType(type) {
  return type === 'response.output_text.delta' || type === 'output_text_delta';
}

// Codex occasionally exits 1 with empty stderr after streaming a few bytes of
// assistant text — most often a transient backend hiccup, never accompanied by
// a structured `error` event. Retrying once almost always succeeds. Any non-
// silent failure (real stderr, hang, no assistant output) skips retry.
const MAX_TRANSIENT_RETRIES = 1;

function createRetryState(streamJson) {
  return {
    emitter: makeTextEmitter(streamJson),
    startedAt: Date.now(),
    logicalText: '',
    replayPrefix: '',
    replayCursor: 0,
    emittedTexts: new Set(),
    usageTotals: emptyUsage(),
    sessionId: '',
  };
}

function trimRetriedPrefix(text, retryState, attempt) {
  if (attempt === 0 || !text || retryState.replayCursor >= retryState.replayPrefix.length) {
    return text;
  }
  const remainingPrefix = retryState.replayPrefix.slice(retryState.replayCursor);
  let matched = 0;
  while (
    matched < text.length &&
    matched < remainingPrefix.length &&
    text[matched] === remainingPrefix[matched]
  ) {
    matched += 1;
  }
  retryState.replayCursor += matched;
  if (matched === text.length) {
    return '';
  }
  if (matched > 0) {
    return text.slice(matched);
  }
  retryState.replayCursor = retryState.replayPrefix.length;
  return text;
}

function writeLogicalText(text, emitter, retryState, attempt) {
  const trimmed = trimRetriedPrefix(text, retryState, attempt);
  if (!trimmed) return '';
  retryState.logicalText += trimmed;
  emitter.write(trimmed);
  return trimmed;
}

function launchCodex({ prompt, model, streamJson, attempt = 0, retryState = null }) {
  return new Promise((resolve, reject) => {
    const codexBin = process.env.CODEX_BIN || 'codex';
    const codexArgs = [
      ...permissionArgsFor(permissionMode),
      ...brokerConfigFlags(process.env),
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
    const signalForwarding = installSignalForwarding(() => child);

    child = spawn(codexBin, codexArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    signalForwarding.forwardPending();

    const watchdog = installInactivityWatchdog(child, { shimName: 'codex-shim' });
    const state = retryState || createRetryState(streamJson);
    const emitter = state.emitter;
    let stdoutBuffer = '';
    let stderr = '';
    let fullText = '';
    let usage = emptyUsage();
    let usageCaptured = false;
    let sessionId = state.sessionId || resumeSessionId;

    child.stdin.on('error', (err) => {
      if (isBrokenPipeError(err)) return;
      if (!stderr.trim()) stderr = `[codex-shim] failed to write prompt to codex stdin: ${err.message}`;
      try { child.kill('SIGTERM'); } catch { /* child may already be gone */ }
    });
    child.stdin.end(prompt);

    const handleLine = (line) => {
      if (!line.trim()) return;
      if (!streamJson) {
        fullText += `${line}\n`;
        emitter.write(`${line}\n`);
        return;
      }
      const event = parseJsonLine(line);
      if (!event) {
        fullText += `${line}\n`;
        emitter.write(`${line}\n`);
        return;
      }
      const payload = unwrapCodexEvent(event);
      const type = payload?.type || event.type || '';
      if (!isCodexEvent(event, payload, type)) {
        fullText += `${line}\n`;
        emitter.write(`${line}\n`);
        return;
      }
      sessionId = sessionFromEvent(payload) || sessionFromEvent(event) || sessionId;
      if (sessionId) state.sessionId = sessionId;
      if (type === 'token_count' || type === 'turn.completed') {
        usage = usageFromTokenCount(payload);
        usageCaptured = true;
        return;
      }
      if (
        type === 'agent_message' ||
        type === 'assistant_message' ||
        type === 'message' ||
        isDeltaEventType(type)
      ) {
        if (event.type === 'response_item' && type === 'message' && payload?.role !== 'assistant') return;
        const text = textFromEvent(payload);
        if (!isDeltaEventType(type) && !shouldEmitText(text, state.emittedTexts)) return;
        const written = writeLogicalText(text, emitter, state, attempt);
        if (!written) return;
        fullText += written;
      } else if (type === 'item.completed') {
        const text = textFromCompletedItem(event);
        if (!shouldEmitText(text, state.emittedTexts)) return;
        const written = writeLogicalText(text, emitter, state, attempt);
        if (!written) return;
        fullText += written;
      } else if (type === 'task_complete') {
        const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
        if (!shouldEmitText(text, state.emittedTexts)) return;
        const written = writeLogicalText(text, emitter, state, attempt);
        if (!written) return;
        fullText += written;
      } else if (type === 'error') {
        const message = textFromEvent(payload) || payload.error?.message || event.error?.message || 'Codex error';
        const written = writeLogicalText(message, emitter, state, attempt);
        if (!written) return;
        fullText += written;
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
      signalForwarding.dispose();
      watchdog.dispose();
      reject(err);
    });
    child.on('close', (code, signal) => {
      signalForwarding.dispose();
      watchdog.dispose();
      if (watchdog.timedOut() && !stderr.trim()) {
        stderr = `[codex-shim] killed by inactivity watchdog after ${process.env.SHIM_INACTIVITY_TIMEOUT_MS || 600000}ms with no output from child`;
      }
      if (stdoutBuffer) handleLine(stdoutBuffer);
      state.usageTotals = addUsageTotals(
        state.usageTotals,
        usageCaptured ? usage : { inputTokens: estimateTokens(prompt), outputTokens: 0, cacheReadInputTokens: 0 }
      );
      const isSilentCrash = streamJson
        && code === 1
        && !signal
        && !stderr.trim()
        && Boolean((fullText || state.logicalText).trim());
      if (isSilentCrash && attempt < MAX_TRANSIENT_RETRIES) {
        // Surface the retry to the user-visible stream so the log explains the
        // gap, then re-launch with the same args. Don't close the emitter —
        // attempt 2's stream concatenates into the same content block.
        state.replayPrefix = state.logicalText;
        state.replayCursor = 0;
        emitter.write(`\n[codex-shim] codex exited 1 with no stderr after streaming output — retrying once (attempt ${attempt + 2}/${MAX_TRANSIENT_RETRIES + 1})\n`);
        process.stderr.write(`[codex-shim] transient codex crash (exit 1, no stderr) — retrying\n`);
        launchCodex({ prompt, model, streamJson, attempt: attempt + 1, retryState: state })
          .then(resolve, reject);
        return;
      }
      emitter.close();
      if (!streamJson && fullText && !fullText.endsWith('\n')) process.stdout.write('\n');
      const logicalOutput = state.logicalText.trim();
      if (streamJson) {
        const noAssistantOutput = code === 0 && !logicalOutput;
        emitResult({
          model,
          durationMs: Date.now() - state.startedAt,
          sessionId: state.sessionId || sessionId,
          inputTokens: state.usageTotals.inputTokens || estimateTokens(prompt),
          outputTokens: state.usageTotals.outputTokens || estimateTokens(state.logicalText),
          cacheReadInputTokens: state.usageTotals.cacheReadInputTokens || 0,
          error: code !== 0 || noAssistantOutput,
          result: code === 0
            ? (noAssistantOutput ? '[codex-shim] codex produced no assistant output' : '')
            : errorResultText({ code, signal, stderr, fullText: state.logicalText || fullText }),
        });
      } else if (code !== 0 && stderr.trim()) {
        process.stderr.write(stderr);
      }
      const signalExitCode = signal ? 128 + (require('os').constants.signals[signal] || 0) : 1;
      resolve((code === 0 && streamJson && !logicalOutput) ? 1 : (code ?? signalExitCode));
    });
  });
}

// Exit only after stdout has drained. `console.log`/`emitResult` write to a
// pipe (TamTam captures the shim's stdout to a log file), and `process.exit`
// discards any bytes still buffered in that pipe — which silently truncates the
// terminal `{"type":"result",…}` line the log watcher needs. Without it,
// probe.getClaudeResultExitCode reads null and the job is reaped as exit -1
// ("CLI wrote JSON to the log but never emitted a final result line") 30 min
// later. claude-shim.js gates its exit the same way via maybeExit(). A short
// safety timeout guarantees we never hang waiting on a stuck pipe.
function flushThenExit(code) {
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(code); };
  const timer = setTimeout(finish, 2000);
  if (timer.unref) timer.unref();
  if (process.stdout.writableLength === 0) { finish(); return; }
  process.stdout.write('', finish);
}

if (require.main === module) (async () => {
  const stdinPrompt = await readStdin();
  const prompt = promptArg || stdinPrompt;
  const streamJson = outputFormat === 'stream-json';
  const model = resolveModel(requestedModel);

  if (!prompt.trim()) {
    if (streamJson) emitResult({ model, durationMs: 0, error: true, result: '[codex-shim] prompt is empty' });
    else console.error('[codex-shim] prompt is empty');
    flushThenExit(1);
    return;
  }

  try {
    const code = await launchCodex({ prompt, model, streamJson });
    flushThenExit(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (streamJson) emitResult({ model, durationMs: 0, error: true, result: `[codex-shim] ${message}` });
    else console.error(`[codex-shim] ${message}`);
    flushThenExit(1);
  }
})();

module.exports = { resolveModel, brokerConfigFlags, permissionArgsFor, sandboxFor, approvalFor };
