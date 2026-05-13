#!/usr/bin/env node
/* eslint-env node */
/**
 * Fake Codex executable for pipeline e2e tests.
 *
 * scripts/codex-shim.js invokes `codex exec` and expects Codex JSONL events.
 * This mock emits the event shape produced by Codex v0.125:
 * thread.started → turn.started → item.completed(agent_message) → turn.completed.
 */

const fs = require('fs');
const path = require('path');

const SHIM_DIR = process.env.TAMTAM_E2E_SHIM_DIR || '/tmp/tamtam-e2e-pipeline/shim-state';
const projectName = path.basename(process.cwd());
const projectShimDir = path.join(SHIM_DIR, projectName);
const scenarioFile = path.join(projectShimDir, 'scenario.json');
const counterFile = path.join(projectShimDir, 'counter');

let scenario = { steps: [] };
try {
  scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf-8'));
} catch {
  scenario = {
    steps: [
      { text: 'The implementation looks good.\n\nVerdict: LGTM' },
      { text: 'feat: update implementation' },
    ],
  };
}

let counter = 0;
try {
  counter = parseInt(fs.readFileSync(counterFile, 'utf-8').trim(), 10) || 0;
} catch {
  counter = 0;
}

const step = scenario.steps[counter] ?? scenario.steps[scenario.steps.length - 1] ?? { text: 'feat: fallback' };

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

try {
  fs.mkdirSync(projectShimDir, { recursive: true });
  fs.writeFileSync(counterFile, String(counter + 1));
} catch { /* best-effort */ }

if (step.sleep_ms && step.sleep_ms > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleep_ms);
}

// The harness can mark Codex-backed jobs done as soon as the translated
// terminal event is observed, so apply scripted workspace mutations first.
applyFileWrites(step.write_files);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const sessionId = `e2e-codex-session-${projectName}-${counter}`;
const text = String(step.text ?? '');

emit({ type: 'thread.started', thread_id: sessionId });
emit({ type: 'turn.started' });
emit({
  type: 'item.completed',
  item: {
    id: `item_${counter}`,
    type: 'agent_message',
    text,
  },
});
emit({
  type: 'turn.completed',
  usage: {
    input_tokens: 42,
    output_tokens: Math.max(1, Math.ceil(text.length / 4)),
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
  },
});
