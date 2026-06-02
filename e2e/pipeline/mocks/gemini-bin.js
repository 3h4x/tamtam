#!/usr/bin/env node
/* eslint-env node */
/**
 * Fake Gemini executable for pipeline e2e tests.
 *
 * scripts/gemini-shim.js expects line-delimited Gemini stream-json events.
 * This mock reuses the same per-project scenario files as the Claude/Codex
 * harness so real pipeline specs can route through a quota-free provider.
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
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, String(fileWrite.content ?? ''));
  }
}

try {
  fs.mkdirSync(projectShimDir, { recursive: true });
  fs.writeFileSync(counterFile, String(counter + 1));
} catch {}

if (step.sleep_ms && step.sleep_ms > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleep_ms);
}

applyFileWrites(step.write_files);

const text = String(step.text ?? '');
const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1] || 'flash'
  : 'flash';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

emit({
  type: 'message',
  role: 'assistant',
  content: text,
});

emit({
  type: 'result',
  status: 'success',
  model,
  stats: {
    input_tokens: 42,
    output_tokens: Math.max(1, Math.ceil(text.length / 4)),
    cached: 0,
    duration_ms: step.sleep_ms ?? 0,
  },
});
