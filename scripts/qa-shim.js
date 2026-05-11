#!/usr/bin/env node
/* eslint-env node */

const fs = require('fs');

const args = process.argv.slice(2);

function valueAfter(flag) {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
}

function has(flag) {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function readPrompt() {
  const inline = valueAfter('-p') || valueAfter('--prompt');
  if (inline) return inline;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitText(text) {
  emitJson({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function commitTitle(prompt) {
  if (/package\.json|pnpm-lock\.yaml/i.test(prompt)) return 'chore: update dependencies';
  if (/docs|readme/i.test(prompt)) return 'docs: refresh project documentation';
  if (/test|spec/i.test(prompt)) return 'test: update qa coverage';
  return 'chore: apply qa workspace changes';
}

function responseFor(prompt) {
  const compact = prompt.replace(/\s+/g, ' ').trim().slice(0, 260);
  if (/review|verdict|LGTM|NEEDS ATTENTION|DO NOT SHIP/i.test(prompt)) {
    return [
      'QA review completed.',
      '',
      'Verdict: LGTM',
      '',
      'Finding ID: qa-smoke-001',
      'Severity: low',
      'Status: informational',
      'Summary: Deterministic qa-shim response for release pipeline testing.',
    ].join('\n');
  }
  if (/definition of done|mark dod|acceptance criteria/i.test(prompt)) {
    return 'QA DoD check completed. Acceptance criteria look satisfied.';
  }
  return [
    'QA shim response',
    '',
    `Received prompt: ${compact || '(empty prompt)'}`,
    '',
    'No external provider was called. This deterministic response is safe for UI and pipeline testing.',
  ].join('\n');
}

const prompt = readPrompt();
const model = valueAfter('--model') || 'normal';
const streamJson = valueAfter('--output-format') === 'stream-json' || has('--include-partial-messages');

if (!streamJson) {
  process.stdout.write(`${commitTitle(prompt)}\n`);
  process.exit(0);
}

const text = responseFor(prompt);
emitJson({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } });
for (const chunk of text.match(/[\s\S]{1,80}/g) || []) emitText(chunk);
emitJson({ type: 'stream_event', event: { type: 'content_block_stop' } });
emitJson({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 250,
  session_id: `qa-${Date.now()}`,
  result: text,
  modelUsage: {
    [model]: {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(text),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
});
