import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const QA_SHIM = resolve(__dirname, '..', '..', 'scripts', 'qa-shim.js');

function runShim(args: string[], stdinInput?: string) {
  return spawnSync(process.execPath, [QA_SHIM, ...args], {
    input: stdinInput,
    encoding: 'utf-8',
    env: process.env,
  });
}

function parseNdjson(stdout: string) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('scripts/qa-shim.js', () => {
  describe('non-stream-json mode', () => {
    it('outputs commit title for generic prompt and exits 0', () => {
      const result = runShim(['-p', 'fix the bug']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('chore: apply qa workspace changes');
    });

    it('returns dependency commit title for package.json prompt', () => {
      const result = runShim(['-p', 'update package.json and pnpm-lock.yaml']);
      expect(result.stdout.trim()).toBe('chore: update dependencies');
    });

    it('returns docs commit title for readme prompt', () => {
      const result = runShim(['-p', 'update README with new docs']);
      expect(result.stdout.trim()).toBe('docs: refresh project documentation');
    });

    it('returns test commit title for spec prompt', () => {
      const result = runShim(['-p', 'add test coverage for new spec']);
      expect(result.stdout.trim()).toBe('test: update qa coverage');
    });

    it('reads prompt from stdin when no -p flag', () => {
      const result = runShim([], 'update package.json');
      expect(result.stdout.trim()).toBe('chore: update dependencies');
    });

    it('returns default title for empty stdin', () => {
      const result = runShim([], '');
      expect(result.stdout.trim()).toBe('chore: apply qa workspace changes');
    });
  });

  describe('stream-json mode via --output-format=stream-json', () => {
    it('emits content_block_start, text deltas, content_block_stop, and result events', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'do something generic']);
      expect(result.status).toBe(0);

      const events = parseNdjson(result.stdout);
      const types = events.map((e: { type: string }) => e.type);
      expect(types).toContain('stream_event');
      expect(types).toContain('result');

      const streamEvents = events.filter((e: { type: string }) => e.type === 'stream_event');
      const eventTypes = streamEvents.map((e: { event: { type: string } }) => e.event.type);
      expect(eventTypes).toContain('content_block_start');
      expect(eventTypes).toContain('content_block_delta');
      expect(eventTypes).toContain('content_block_stop');
    });

    it('emits LGTM verdict for review prompt', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'please review this code and give a verdict']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent).toBeDefined();
      expect(resultEvent.result).toContain('Verdict: LGTM');
      expect(resultEvent.result).toContain('QA review completed.');
    });

    it('emits DoD response for definition-of-done prompt', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'check the definition of done']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('QA DoD check completed');
      expect(resultEvent.result).toContain('Acceptance criteria');
    });

    it('emits generic response with truncated prompt for unknown prompt', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'do something unrecognized']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('QA shim response');
      expect(resultEvent.result).toContain('do something unrecognized');
    });

    it('shows (empty prompt) placeholder when prompt is blank', () => {
      const result = runShim(['--output-format=stream-json', '-p', '']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('(empty prompt)');
    });

    it('includes modelUsage keyed by the --model flag', () => {
      const result = runShim(['--output-format=stream-json', '--model', 'smart', '-p', 'do something']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.modelUsage).toHaveProperty('smart');
      expect(resultEvent.modelUsage.smart.inputTokens).toBeGreaterThan(0);
      expect(resultEvent.modelUsage.smart.outputTokens).toBeGreaterThan(0);
    });

    it('defaults model to "normal" when --model is omitted', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'do something']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.modelUsage).toHaveProperty('normal');
    });

    it('marks result as non-error and sets duration_ms', () => {
      const result = runShim(['--output-format=stream-json', '-p', 'ping']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.is_error).toBe(false);
      expect(resultEvent.subtype).toBe('success');
      expect(typeof resultEvent.duration_ms).toBe('number');
    });
  });

  describe('stream-json mode via --include-partial-messages', () => {
    it('activates stream-json output when flag is present', () => {
      const result = runShim(['--include-partial-messages', '-p', 'some prompt']);
      expect(result.status).toBe(0);
      const events = parseNdjson(result.stdout);
      expect(events.some((e: { type: string }) => e.type === 'result')).toBe(true);
    });
  });
});
