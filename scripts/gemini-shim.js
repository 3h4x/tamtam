#!/usr/bin/env node
/* eslint-env node */

/**
 * Gemini-to-Claude CLI Shim
 * Translates Gemini CLI stream-json output to Claude CLI stream-json format
 * for compatibility with TamTam.
 */
const { spawn } = require('child_process');
const readline = require('readline');

function resolveGeminiModel(model) {
  const aliases = {
    fast: process.env.GEMINI_FAST_MODEL || process.env.GEMINI_HAIKU_MODEL || 'flash',
    normal: process.env.GEMINI_NORMAL_MODEL || process.env.GEMINI_SONNET_MODEL || 'pro',
    smart: process.env.GEMINI_SMART_MODEL || process.env.GEMINI_OPUS_MODEL || 'pro',
    haiku: process.env.GEMINI_FAST_MODEL || process.env.GEMINI_HAIKU_MODEL || 'flash',
    sonnet: process.env.GEMINI_NORMAL_MODEL || process.env.GEMINI_SONNET_MODEL || 'pro',
    opus: process.env.GEMINI_SMART_MODEL || process.env.GEMINI_OPUS_MODEL || 'pro',
    thinking: process.env.GEMINI_THINKING_MODEL || 'thinking',
  };
  return aliases[model] || process.env.GEMINI_MODEL || model;
}

// Mapping Claude permission modes to Gemini approval modes
const APPROVAL_MAP = {
  'bypassPermissions': 'yolo',
  'auto': 'auto_edit',
  'plan': 'plan',
  'default': 'default'
};

const args = process.argv.slice(2);
const geminiArgs = ['--prompt', '-'];

let model = resolveGeminiModel('fast');
let approvalMode = 'yolo';
let cwd = process.cwd();

// Parse incoming Claude-style arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--model') {
    if (i + 1 < args.length) {
      const val = args[++i];
      model = resolveGeminiModel(val);
    }
  } else if (arg.startsWith('--model=')) {
    const val = arg.substring('--model='.length);
    model = resolveGeminiModel(val);
  } else if (arg === '--permission-mode') {
    if (i + 1 < args.length) {
      const val = args[++i];
      approvalMode = APPROVAL_MAP[val] || val;
    }
  } else if (arg.startsWith('--permission-mode=')) {
    const val = arg.substring('--permission-mode='.length);
    approvalMode = APPROVAL_MAP[val] || val;
  } else if (arg === '--cwd') {
    if (i + 1 < args.length) {
      cwd = args[++i];
    }
  } else if (arg.startsWith('--cwd=')) {
    cwd = arg.substring('--cwd='.length);
  } else if (arg === '--output-format') {
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      i++; // consume next arg (assumed 'stream-json')
    }
  } else if (arg.startsWith('--output-format=')) {
    // do nothing
  }
}

geminiArgs.push('--model', model);
geminiArgs.push('--approval-mode', approvalMode);
geminiArgs.push('--output-format', 'stream-json');

// Launch Gemini CLI
const gemini = spawn('gemini', geminiArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: cwd,
  env: { ...process.env, FORCE_COLOR: '0' }
});

// Forward stdin (the prompt) to Gemini
process.stdin.pipe(gemini.stdin);

const rl = readline.createInterface({
  input: gemini.stdout,
  terminal: false
});

let inTextBlock = false;

// Map Gemini JSON events to Claude JSON events
rl.on('line', (line) => {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    // Pass through non-JSON lines (e.g. status messages)
    // but don't emit them as JSON to avoid confusing the parser
    console.log(line);
    return;
  }

  try {
    // Assistant message -> text_delta
    if (data.type === 'message' && data.role === 'assistant') {
      if (!inTextBlock) {
        console.log(JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'text',
              text: ''
            }
          }
        }));
        inTextBlock = true;
      }
      console.log(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: data.content
          }
        }
      }));
    } 
    // Tool use -> content_block_start + content_block_delta + content_block_stop
    else if (data.type === 'tool_use') {
       if (inTextBlock) {
         console.log(JSON.stringify({
           type: 'stream_event',
           event: {
             type: 'content_block_stop'
           }
         }));
         inTextBlock = false;
       }
       console.log(JSON.stringify({
         type: 'stream_event',
         event: {
           type: 'content_block_start',
           content_block: {
             type: 'tool_use',
             name: data.tool_name,
             id: data.tool_id
           }
         }
       }));
       console.log(JSON.stringify({
         type: 'stream_event',
         event: {
           type: 'content_block_delta',
           delta: {
             type: 'input_json_delta',
             partial_json: JSON.stringify(data.parameters || {})
           }
         }
       }));
       console.log(JSON.stringify({
         type: 'stream_event',
         event: {
           type: 'content_block_stop'
         }
       }));
    } 
    // Tool result -> system tool_result
    else if (data.type === 'tool_result') {
      if (inTextBlock) {
        console.log(JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_stop'
          }
        }));
        inTextBlock = false;
      }
      console.log(JSON.stringify({
        type: 'system',
        subtype: 'tool_result',
        content: `[Tool ${data.status || 'finished'}]`
      }));
    } 
    // Final result -> summary result
    else if (data.type === 'result') {
      if (inTextBlock) {
        console.log(JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_stop'
          }
        }));
        inTextBlock = false;
      }
      const stats = data.stats || {};
      const modelName = data.model || model;
      console.log(JSON.stringify({
        type: 'result',
        modelUsage: {
          [modelName]: {
            inputTokens: stats.input_tokens || 0,
            outputTokens: stats.output_tokens || 0,
            cacheReadInputTokens: stats.cached || 0,
            cacheCreationInputTokens: 0
          }
        },
        duration_ms: stats.duration_ms || 0,
        is_error: data.status === 'error',
        result: data.error || ''
      }));
    }
  } catch (err) {
    // Emitting error event in Claude protocol format
    console.log(JSON.stringify({
      type: 'result',
      is_error: true,
      result: `Internal shim error: ${err instanceof Error ? err.message : String(err)}`
    }));
  }
});

gemini.on('exit', (code, signal) => {
  if (inTextBlock) {
    console.log(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_stop'
      }
    }));
    inTextBlock = false;
  }
  if (signal) {
    process.exit(1);
  }
  process.exit(code !== null ? code : 0);
});

gemini.on('error', (err) => {
  if (inTextBlock) {
    console.log(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_stop'
      }
    }));
    inTextBlock = false;
  }
  console.log(JSON.stringify({
    type: 'result',
    is_error: true,
    result: `[shim] gemini error: ${err.message}`
  }));
  process.exit(1);
});
