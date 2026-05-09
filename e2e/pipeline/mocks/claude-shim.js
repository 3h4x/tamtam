#!/usr/bin/env node
/* eslint-env node */
/**
 * TamTam e2e Claude CLI shim.
 *
 * Reads a scripted scenario from the shim-state directory (keyed by project
 * name derived from CWD), advances a call counter, and emits either plain
 * text (--print without --output-format) or NDJSON stream-json.
 *
 * State dir: $TAMTAM_E2E_SHIM_DIR or /tmp/tamtam-e2e-pipeline/shim-state
 * Project name: basename of process.cwd() (PM2 sets cwd to the project path)
 */

const fs = require('fs');
const path = require('path');

const SHIM_DIR = process.env.TAMTAM_E2E_SHIM_DIR || '/tmp/tamtam-e2e-pipeline/shim-state';
const projectName = path.basename(process.cwd());
const projectShimDir = path.join(SHIM_DIR, projectName);

const scenarioFile = path.join(projectShimDir, 'scenario.json');
const counterFile = path.join(projectShimDir, 'counter');

function readPromptFromStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

// Determine output mode from argv
const args = process.argv.slice(2);
function hasFlag(flag) {
  return args.includes(flag);
}
function flagValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const outputFormat = flagValue('--output-format') ?? '';
const isStreamJson = outputFormat === 'stream-json' || args.some(a => a === '--output-format=stream-json');

// Read scenario
let scenario = { steps: [] };
try {
  scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf-8'));
} catch {
  // Missing scenario — fall back to a generic LGTM so the pipeline can complete
  scenario = {
    steps: [
      { text: 'The implementation looks good.\n\nVerdict: LGTM' },
      { text: 'feat: update implementation' },
    ],
  };
}

// Read and advance counter
let counter = 0;
try {
  const raw = fs.readFileSync(counterFile, 'utf-8').trim();
  counter = parseInt(raw, 10) || 0;
} catch {
  // counter file missing → start at 0
}

const step = scenario.steps[counter] ?? scenario.steps[scenario.steps.length - 1] ?? { text: 'feat: fallback' };
const prompt = readPromptFromStdin();

function buildPromptDrivenText() {
  const textParts = [];
  const failures = [];

  for (const required of step.prompt_assert_contains ?? []) {
    if (!prompt.includes(required)) failures.push(`missing "${required}"`);
  }
  for (const forbidden of step.prompt_assert_not_contains ?? []) {
    if (prompt.includes(forbidden)) failures.push(`unexpected "${forbidden}"`);
  }
  for (const capture of step.prompt_capture ?? []) {
    try {
      const re = new RegExp(capture.regex, capture.flags || '');
      const match = prompt.match(re);
      const index = typeof capture.group === 'number' ? capture.group : 1;
      textParts.push(
        `${capture.label}: ${match ? (match[index] ?? match[0]) : '[missing]'}`,
      );
      if (!match) failures.push(`capture "${capture.label}" did not match ${capture.regex}`);
    } catch (error) {
      failures.push(`invalid regex for "${capture.label}": ${error.message}`);
    }
  }

  if (failures.length > 0) {
    textParts.unshift(`PROMPT ASSERTION FAILED: ${failures.join('; ')}`);
  }

  return {
    extraText: textParts.length > 0 ? textParts.join('\n') : '',
    failed: failures.length > 0,
  };
}

const promptDriven = buildPromptDrivenText();
const stepText = [step.text, promptDriven.extraText].filter(Boolean).join('\n');

function applyFileWrites(fileWrites) {
  if (!Array.isArray(fileWrites)) return;
  for (const fileWrite of fileWrites) {
    if (!fileWrite || typeof fileWrite.path !== 'string') continue;
    const targetPath = path.join(process.cwd(), fileWrite.path);
    const targetDir = path.dirname(targetPath);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, String(fileWrite.content ?? ''));
  }
}

// Write incremented counter before emitting output (atomic-ish: if the shim
// crashes mid-output the counter is still advanced so the next call gets the
// right step rather than replaying the same one forever).
try {
  fs.mkdirSync(projectShimDir, { recursive: true });
  fs.writeFileSync(counterFile, String(counter + 1));
} catch { /* best-effort */ }

// If the step requests a delay, sleep synchronously before emitting.
// Atomics.wait is interruptible by SIGTERM so abort tests work cleanly.
if (step.sleep_ms && step.sleep_ms > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleep_ms);
}

// TamTam treats the terminal result event as the completion boundary for
// claude-backed jobs, so scenario side effects must land before we emit it.
applyFileWrites(step.write_files);

if (isStreamJson) {
  // Emit Claude-compatible NDJSON stream-json events
  function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'text', text: '' },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: stepText },
    },
  });
  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: promptDriven.failed,
    result: '',
    session_id: `e2e-session-${projectName}-${counter}`,
    modelUsage: {
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: Math.max(5, stepText.length / 4 | 0),
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    duration_ms: 50,
  });
} else {
  // Plain-text mode (commit message generation uses --print without stream-json)
  process.stdout.write(stepText + '\n');
}

process.exit(promptDriven.failed ? 1 : 0);
