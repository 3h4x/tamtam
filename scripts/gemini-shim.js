#!/usr/bin/env node
/* eslint-env node */

/**
 * Gemini-to-Claude CLI Shim
 * Translates Gemini CLI stream-json output to Claude CLI stream-json format
 * for compatibility with TamTam.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const { installInactivityWatchdog, installSignalForwarding } = require('./shim-utils');

// Mapping Claude permission modes to Gemini approval modes
const APPROVAL_MAP = {
  'bypassPermissions': 'yolo',
  'acceptEdits': 'auto_edit',
  'auto': 'auto_edit',
  'dontAsk': 'auto_edit',
  'plan': 'plan',
  'default': 'auto_edit'
};

function resolveGeminiModel(model, env) {
  const e = env || process.env;
  const aliases = {
    fast: e.GEMINI_FAST_MODEL || e.GEMINI_HAIKU_MODEL || 'flash',
    normal: e.GEMINI_NORMAL_MODEL || e.GEMINI_SONNET_MODEL || 'pro',
    smart: e.GEMINI_SMART_MODEL || e.GEMINI_OPUS_MODEL || 'pro',
    haiku: e.GEMINI_FAST_MODEL || e.GEMINI_HAIKU_MODEL || 'flash',
    sonnet: e.GEMINI_NORMAL_MODEL || e.GEMINI_SONNET_MODEL || 'pro',
    opus: e.GEMINI_SMART_MODEL || e.GEMINI_OPUS_MODEL || 'pro',
    thinking: e.GEMINI_THINKING_MODEL || 'thinking',
  };
  return aliases[model] || e.GEMINI_MODEL || model;
}

/**
 * Parse Claude-style CLI args and build the args array to pass to gemini.
 * Returns { model, approvalMode, cwd, geminiArgs }.
 */
function parseShimArgs(argv, env) {
  const e = env || process.env;
  let model = resolveGeminiModel('fast', e);
  let approvalMode = 'yolo';
  let cwd = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') {
      if (i + 1 < argv.length) {
        const val = argv[++i];
        model = resolveGeminiModel(val, e);
      }
    } else if (arg.startsWith('--model=')) {
      model = resolveGeminiModel(arg.substring('--model='.length), e);
    } else if (arg === '--permission-mode') {
      if (i + 1 < argv.length) {
        const val = argv[++i];
        approvalMode = APPROVAL_MAP[val] || val;
      }
    } else if (arg.startsWith('--permission-mode=')) {
      const val = arg.substring('--permission-mode='.length);
      approvalMode = APPROVAL_MAP[val] || val;
    } else if (arg === '--cwd') {
      if (i + 1 < argv.length) cwd = argv[++i];
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.substring('--cwd='.length);
    } else if (arg === '--output-format') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i++; // consume next arg (assumed 'stream-json')
      }
    } else if (arg.startsWith('--output-format=')) {
      // do nothing — consumed
    }
  }

  const geminiArgs = ['--prompt', '-', '--model', model, '--approval-mode', approvalMode, '--output-format', 'stream-json'];
  return { model, approvalMode, cwd, geminiArgs };
}

/**
 * Create a stateful Gemini → Claude stream-json translator.
 * translateLine(line) returns an array of JSON strings to emit.
 * flush() closes any open text block and returns its JSON strings.
 */
function createGeminiTranslator(modelName) {
  let inTextBlock = false;

  function translateLine(line) {
    const outputs = [];
    const emit = (obj) => outputs.push(JSON.stringify(obj));

    let data;
    try {
      data = JSON.parse(line);
    } catch {
      outputs.push(line);
      return outputs;
    }

    try {
      if (data.type === 'message' && data.role === 'assistant') {
        if (!inTextBlock) {
          emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } });
          inTextBlock = true;
        }
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: data.content } } });
      } else if (data.type === 'tool_use') {
        if (inTextBlock) {
          emit({ type: 'stream_event', event: { type: 'content_block_stop' } });
          inTextBlock = false;
        }
        emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: data.tool_name, id: data.tool_id } } });
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify(data.parameters || {}) } } });
        emit({ type: 'stream_event', event: { type: 'content_block_stop' } });
      } else if (data.type === 'tool_result') {
        if (inTextBlock) {
          emit({ type: 'stream_event', event: { type: 'content_block_stop' } });
          inTextBlock = false;
        }
        emit({ type: 'system', subtype: 'tool_result', content: `[Tool ${data.status || 'finished'}]` });
      } else if (data.type === 'result') {
        if (inTextBlock) {
          emit({ type: 'stream_event', event: { type: 'content_block_stop' } });
          inTextBlock = false;
        }
        const stats = data.stats || {};
        const model = data.model || modelName;
        emit({
          type: 'result',
          modelUsage: {
            [model]: {
              inputTokens: stats.input_tokens || 0,
              outputTokens: stats.output_tokens || 0,
              cacheReadInputTokens: stats.cached || 0,
              cacheCreationInputTokens: 0,
            }
          },
          duration_ms: stats.duration_ms || 0,
          is_error: data.status === 'error',
          result: data.error || '',
        });
      }
    } catch (err) {
      emit({ type: 'result', is_error: true, result: `Internal shim error: ${err instanceof Error ? err.message : String(err)}` });
    }

    return outputs;
  }

  function flush() {
    const outputs = [];
    if (inTextBlock) {
      outputs.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }));
      inTextBlock = false;
    }
    return outputs;
  }

  return { translateLine, flush };
}

if (require.main === module) {
  const { model, geminiArgs, cwd } = parseShimArgs(process.argv.slice(2));

  const geminiBin = process.env.GEMINI_BIN || 'gemini';
  let gemini;
  const signalForwarding = installSignalForwarding(() => gemini);
  gemini = spawn(geminiBin, geminiArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: cwd || process.cwd(),
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  signalForwarding.forwardPending();

  const watchdog = installInactivityWatchdog(gemini, { shimName: 'gemini-shim' });
  gemini.stdout.on('data', () => watchdog.markActivity());
  gemini.stderr.on('data', (chunk) => {
    watchdog.markActivity();
    process.stderr.write(chunk);
  });

  process.stdin.pipe(gemini.stdin);

  const rl = readline.createInterface({ input: gemini.stdout, terminal: false });
  const translator = createGeminiTranslator(model);

  rl.on('line', (line) => {
    for (const out of translator.translateLine(line)) {
      console.log(out);
    }
  });

  gemini.on('close', (code, signal) => {
    signalForwarding.dispose();
    watchdog.dispose();
    for (const out of translator.flush()) {
      console.log(out);
    }
    if (watchdog.timedOut()) {
      console.log(JSON.stringify({ type: 'result', is_error: true, result: '[gemini-shim] killed by inactivity watchdog' }));
      process.exit(124);
    }
    if (signal) {
      process.exit(1);
    }
    process.exit(code !== null ? code : 0);
  });

  gemini.on('error', (err) => {
    signalForwarding.dispose();
    watchdog.dispose();
    for (const out of translator.flush()) {
      console.log(out);
    }
    console.log(JSON.stringify({ type: 'result', is_error: true, result: `[shim] gemini error: ${err.message}` }));
    process.exit(1);
  });
}

module.exports = { resolveGeminiModel, APPROVAL_MAP, parseShimArgs, createGeminiTranslator };
