import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';

const QA_SHIM = resolve(__dirname, '..', '..', 'scripts', 'qa-shim.js');

function runShim(args: string[], stdinInput?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [QA_SHIM, ...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolvePromise({ status, stdout, stderr });
    });
    if (typeof stdinInput === 'string') {
      child.stdin.end(stdinInput);
      return;
    }
    child.stdin.end();
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
    it.concurrent('outputs commit title for generic prompt and exits 0', async () => {
      const result = await runShim(['-p', 'fix the bug']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('chore: apply qa workspace changes');
    });

    it.concurrent('returns dependency commit title for package.json prompt', async () => {
      const result = await runShim(['-p', 'update package.json and pnpm-lock.yaml']);
      expect(result.stdout.trim()).toBe('chore: update dependencies');
    });

    it.concurrent('returns docs commit title for readme prompt', async () => {
      const result = await runShim(['-p', 'update README with new docs']);
      expect(result.stdout.trim()).toBe('docs: refresh project documentation');
    });

    it.concurrent('returns test commit title for spec prompt', async () => {
      const result = await runShim(['-p', 'add test coverage for new spec']);
      expect(result.stdout.trim()).toBe('test: update qa coverage');
    });

    it.concurrent('reads prompt from stdin when no -p flag', async () => {
      const result = await runShim([], 'update package.json');
      expect(result.stdout.trim()).toBe('chore: update dependencies');
    });

    it.concurrent('returns default title for empty stdin', async () => {
      const result = await runShim([], '');
      expect(result.stdout.trim()).toBe('chore: apply qa workspace changes');
    });
  });

  describe('stream-json mode via --output-format=stream-json', () => {
    it.concurrent('emits content_block_start, text deltas, content_block_stop, and result events', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'do something generic']);
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

    it.concurrent('emits LGTM verdict for review prompt', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'please review this code and give a verdict']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent).toBeDefined();
      expect(resultEvent.result).toContain('Verdict: LGTM');
      expect(resultEvent.result).toContain('QA review completed.');
    });

    it.concurrent('emits DoD response for definition-of-done prompt', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'check the definition of done']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('QA DoD check completed');
      expect(resultEvent.result).toContain('Acceptance criteria');
    });

    it.concurrent('emits generic response with truncated prompt for unknown prompt', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'do something unrecognized']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('QA shim response');
      expect(resultEvent.result).toContain('do something unrecognized');
    });

    it.concurrent('shows (empty prompt) placeholder when prompt is blank', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', '']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.result).toContain('(empty prompt)');
    });

    it.concurrent('includes modelUsage keyed by the --model flag', async () => {
      const result = await runShim(['--output-format=stream-json', '--model', 'smart', '-p', 'do something']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.modelUsage).toHaveProperty('smart');
      expect(resultEvent.modelUsage.smart.inputTokens).toBeGreaterThan(0);
      expect(resultEvent.modelUsage.smart.outputTokens).toBeGreaterThan(0);
    });

    it.concurrent('defaults model to "normal" when --model is omitted', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'do something']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.modelUsage).toHaveProperty('normal');
    });

    it.concurrent('marks result as non-error and sets duration_ms', async () => {
      const result = await runShim(['--output-format=stream-json', '-p', 'ping']);
      const events = parseNdjson(result.stdout);
      const resultEvent = events.find((e: { type: string }) => e.type === 'result');
      expect(resultEvent.is_error).toBe(false);
      expect(resultEvent.subtype).toBe('success');
      expect(typeof resultEvent.duration_ms).toBe('number');
    });
  });

  describe('stream-json mode via --include-partial-messages', () => {
    it.concurrent('activates stream-json output when flag is present', async () => {
      const result = await runShim(['--include-partial-messages', '-p', 'some prompt']);
      expect(result.status).toBe(0);
      const events = parseNdjson(result.stdout);
      expect(events.some((e: { type: string }) => e.type === 'result')).toBe(true);
    });
  });
});
