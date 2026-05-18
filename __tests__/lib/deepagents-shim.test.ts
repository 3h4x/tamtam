import { mkdtemp, rm, writeFile, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let sharedRoot = '';
let sharedFakeDeepAgents = '';
let sharedBehaviorPath = '';
let captureFileId = 0;

beforeAll(async () => {
  sharedRoot = await mkdtemp(join(tmpdir(), 'tamtam-deepagents-shared-'));
  sharedFakeDeepAgents = join(sharedRoot, 'dcode');
  sharedBehaviorPath = join(sharedRoot, 'behavior.js');
  await writeFile(sharedFakeDeepAgents, `#!/usr/bin/env node
const scriptPath = process.env.FAKE_DEEPAGENTS_SCRIPT;
if (!scriptPath) {
  process.stderr.write('FAKE_DEEPAGENTS_SCRIPT not set\\n');
  process.exit(2);
}
require(scriptPath);
`);
  await writeFile(sharedBehaviorPath, `const fs = require('fs');
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OLLAMA_HOST: process.env.OLLAMA_HOST,
    DEEPAGENTS_CODE_OPENAI_API_KEY: process.env.DEEPAGENTS_CODE_OPENAI_API_KEY
  }
}));
process.stdout.write('hello ');
setTimeout(() => process.stdout.write('world'), 5);
`);
  await chmod(sharedFakeDeepAgents, 0o755);
});

afterAll(async () => {
  if (sharedRoot) await rm(sharedRoot, { recursive: true, force: true });
});

function nextCapturePath(): string {
  captureFileId += 1;
  return join(sharedRoot, `capture-${captureFileId}.json`);
}

function runShim(
  shimArgs: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
  stdinContent = 'test prompt',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/deepagents-shim.js', ...shimArgs], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.stdin.end(stdinContent);
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('deepagents-shim', () => {
  it('defaults to the Deep Agents Code dcode executable when no override is set', async () => {
    const capturePath = nextCapturePath();
    const result = await runShim(
      ['--model', 'normal', '--output-format', 'stream-json'],
      {
        DEEPAGENTS_BIN: '',
        PATH: `${sharedRoot}:${process.env.PATH ?? ''}`,
        DEEPAGENTS_MODEL: 'qwen-local',
        CAPTURE_PATH: capturePath,
        FAKE_DEEPAGENTS_SCRIPT: sharedBehaviorPath,
      },
      'default binary prompt',
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const captured = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(captured.argv).toContain('openai:qwen-local');
    expect(captured.argv).toContain('default binary prompt');
  });

  it('translates Claude argv into a Deep Agents non-interactive launch and NDJSON frames', async () => {
    const capturePath = nextCapturePath();
    const { code, stdout, stderr } = await runShim(
      ['--model', 'fast', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits'],
      {
        DEEPAGENTS_BIN: sharedFakeDeepAgents,
        DEEPAGENTS_BACKEND: 'lmstudio',
        DEEPAGENTS_BASE_URL: 'http://127.0.0.1:1234',
        DEEPAGENTS_FAST_MODEL: 'qwen-local',
        CAPTURE_PATH: capturePath,
        FAKE_DEEPAGENTS_SCRIPT: sharedBehaviorPath,
      },
    );

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const captured = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(captured.argv).toContain('--auto-approve');
    expect(captured.argv).toContain('-S');
    expect(captured.argv).toContain('recommended');
    expect(captured.argv).toContain('--model');
    expect(captured.argv).toContain('openai:qwen-local');
    expect(captured.argv).toContain('-n');
    expect(captured.argv).toContain('test prompt');
    expect(captured.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:1234/v1');
    expect(captured.env.DEEPAGENTS_CODE_OPENAI_API_KEY).toBe('lm-studio');

    const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', backend: 'lmstudio' });
    const text = lines
      .filter((line) => line.type === 'stream_event' && line.event?.type === 'content_block_delta')
      .map((line) => line.event.delta.text)
      .join('');
    expect(text).toBe('hello world');
    expect(lines.some((line) => line.type === 'assistant')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'result', is_error: false });
  });

  it('maps Ollama backend and bypass permissions to ollama model plus all shell access', async () => {
    const capturePath = nextCapturePath();
    const result = await runShim(
      ['--model=smart', '--output-format=stream-json', '--permission-mode', 'bypassPermissions', '-p', 'inline prompt'],
      {
        DEEPAGENTS_BIN: sharedFakeDeepAgents,
        DEEPAGENTS_BACKEND: 'ollama',
        DEEPAGENTS_BASE_URL: 'http://ollama.internal:11434',
        DEEPAGENTS_SMART_MODEL: 'qwen3:8b',
        CAPTURE_PATH: capturePath,
        FAKE_DEEPAGENTS_SCRIPT: sharedBehaviorPath,
      },
      '',
    );

    expect(result.code).toBe(0);
    const captured = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(captured.argv).toContain('ollama:qwen3:8b');
    expect(captured.argv).toContain('all');
    expect(captured.argv).toContain('inline prompt');
    expect(captured.env.OLLAMA_HOST).toBe('http://ollama.internal:11434');
  });
});
