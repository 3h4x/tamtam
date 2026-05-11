import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getAgentMemoryPath,
  readAgentMemory,
  ensureAgentMemoryDir,
  buildMemoryBlock,
} from '@/lib/agents/agent-memory';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tamtam-memory-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('getAgentMemoryPath', () => {
  it('returns expected path structure', () => {
    const path = getAgentMemoryPath('/data', 'myproject', 'security-review');
    expect(path).toBe('/data/agent-memory/myproject/security-review.md');
  });

  it('sanitizes agent names with special chars via join passthrough', () => {
    const path = getAgentMemoryPath('/data', 'proj', 'my-agent');
    expect(path).toContain('my-agent.md');
  });

  it('prevents path traversal in agent name', () => {
    const path = getAgentMemoryPath('/data', 'proj', '../../../../etc/evil');
    expect(path).not.toContain('..');
    expect(path).toContain('/data/agent-memory/');
    expect(path).toContain('evil.md');
  });

  it('prevents path traversal in project name', () => {
    const path = getAgentMemoryPath('/data', '../../../../etc', 'agent');
    expect(path).not.toContain('..');
    expect(path).toContain('/data/agent-memory/');
  });
});

describe('readAgentMemory', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when memory file does not exist', () => {
    expect(readAgentMemory(tmpDir, 'proj', 'agent')).toBeNull();
  });

  it('returns file contents when memory file exists', () => {
    const memDir = join(tmpDir, 'agent-memory', 'proj');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'agent.md'), '## Completed\n- Did thing A\n\n## Pending\n- Do thing B');
    const result = readAgentMemory(tmpDir, 'proj', 'agent');
    expect(result).toContain('Did thing A');
    expect(result).toContain('Do thing B');
  });

  it('truncates memory file contents to 2000 chars', () => {
    const memDir = join(tmpDir, 'agent-memory', 'proj');
    mkdirSync(memDir, { recursive: true });
    const longContent = 'x'.repeat(5000);
    writeFileSync(join(memDir, 'agent.md'), longContent);
    const result = readAgentMemory(tmpDir, 'proj', 'agent');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2000);
  });
});

describe('ensureAgentMemoryDir', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates the agent-memory/project directory', () => {
    ensureAgentMemoryDir(tmpDir, 'myproject');
    expect(existsSync(join(tmpDir, 'agent-memory', 'myproject'))).toBe(true);
  });

  it('is idempotent — does not throw if dir already exists', () => {
    ensureAgentMemoryDir(tmpDir, 'myproject');
    expect(() => ensureAgentMemoryDir(tmpDir, 'myproject')).not.toThrow();
  });
});

describe('buildMemoryBlock', () => {
  it('includes memory path', () => {
    const block = buildMemoryBlock('/data/agent-memory/proj/agent.md', null);
    expect(block).toContain('/data/agent-memory/proj/agent.md');
  });

  it('shows empty state message when no prior memory', () => {
    const block = buildMemoryBlock('/path/to/memory.md', null);
    expect(block).toContain('(empty — this is your first run)');
  });

  it('includes current memory contents when present', () => {
    const memory = '## Completed\n- Processed https://example.com/page1';
    const block = buildMemoryBlock('/path/to/memory.md', memory);
    expect(block).toContain('Processed https://example.com/page1');
    expect(block).not.toContain('(empty');
  });

  it('instructs agent to rewrite the memory file with the Write tool (no appending)', () => {
    const block = buildMemoryBlock('/path/to/memory.md', null);
    expect(block).toContain('rewrite the memory file');
    expect(block).toContain('Write tool');
    expect(block).toMatch(/do NOT append/);
  });

  it('mentions char limit', () => {
    const block = buildMemoryBlock('/path/to/memory.md', null);
    expect(block).toMatch(/\d+ characters/);
  });
});
