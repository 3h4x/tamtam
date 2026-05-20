import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getAgentMemoryDir,
  getAgentMemoryPath,
  readAgentMemory,
  ensureAgentMemoryDir,
  buildMemoryBlock,
} from '@/lib/agents/agent-memory';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `tamtam-memory-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  // Real projects always have `.tamtam/` (config.yml / agents/ live there).
  // Memory hangs off that directory, so the test fixture mirrors that.
  mkdirSync(join(dir, '.tamtam'), { recursive: true });
  return dir;
}

describe('getAgentMemoryPath', () => {
  it('returns a path inside <projPath>/.tamtam/cache/agent-memory/', () => {
    const path = getAgentMemoryPath('/repo/myproject', 'security-review');
    expect(path).toBe('/repo/myproject/.tamtam/cache/agent-memory/security-review.md');
  });

  it('keeps the agent name as-is when it has no traversal markers', () => {
    const path = getAgentMemoryPath('/repo/proj', 'my-agent');
    expect(path).toContain('my-agent.md');
  });

  it('prevents path traversal in agent name', () => {
    const path = getAgentMemoryPath('/repo/proj', '../../../../etc/evil');
    // basename() strips the traversal segments, leaving just the final name.
    expect(path).not.toContain('..');
    expect(path).toContain('/repo/proj/.tamtam/cache/agent-memory/');
    expect(path).toContain('evil.md');
  });
});

describe('getAgentMemoryDir', () => {
  it('returns the agent-memory cache directory for the project', () => {
    expect(getAgentMemoryDir('/repo/proj')).toBe('/repo/proj/.tamtam/cache/agent-memory');
  });
});

describe('readAgentMemory', () => {
  let projDir: string;
  beforeEach(() => { projDir = makeTmpProject(); });
  afterEach(() => { rmSync(projDir, { recursive: true, force: true }); });

  it('returns null when memory file does not exist', () => {
    expect(readAgentMemory(projDir, 'agent')).toBeNull();
  });

  it('returns file contents when memory file exists', () => {
    ensureAgentMemoryDir(projDir);
    writeFileSync(getAgentMemoryPath(projDir, 'agent'), '## Completed\n- Did thing A\n\n## Pending\n- Do thing B');
    const result = readAgentMemory(projDir, 'agent');
    expect(result).toContain('Did thing A');
    expect(result).toContain('Do thing B');
  });

  it('truncates memory file contents to 2000 chars', () => {
    ensureAgentMemoryDir(projDir);
    writeFileSync(getAgentMemoryPath(projDir, 'agent'), 'x'.repeat(5000));
    const result = readAgentMemory(projDir, 'agent');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2000);
  });
});

describe('ensureAgentMemoryDir', () => {
  let projDir: string;
  beforeEach(() => { projDir = makeTmpProject(); });
  afterEach(() => { rmSync(projDir, { recursive: true, force: true }); });

  it('creates the .tamtam/cache/agent-memory directory inside the project', () => {
    ensureAgentMemoryDir(projDir);
    expect(existsSync(join(projDir, '.tamtam', 'cache', 'agent-memory'))).toBe(true);
  });

  it('is idempotent — does not throw if the dir already exists', () => {
    ensureAgentMemoryDir(projDir);
    expect(() => ensureAgentMemoryDir(projDir)).not.toThrow();
  });

  it('writes `cache/` to .tamtam/.gitignore so the memory dir is not committed', () => {
    ensureAgentMemoryDir(projDir);
    const gitignore = readFileSync(join(projDir, '.tamtam', '.gitignore'), 'utf-8');
    expect(gitignore.split('\n')).toContain('cache/');
  });

  it('does not duplicate the `cache/` entry on repeated calls', () => {
    ensureAgentMemoryDir(projDir);
    ensureAgentMemoryDir(projDir);
    const gitignore = readFileSync(join(projDir, '.tamtam', '.gitignore'), 'utf-8');
    const occurrences = gitignore.split('\n').filter((line) => line.trim() === 'cache/').length;
    expect(occurrences).toBe(1);
  });

  it('preserves existing .tamtam/.gitignore lines when appending `cache/`', () => {
    const gitignorePath = join(projDir, '.tamtam', '.gitignore');
    writeFileSync(gitignorePath, 'local-notes/\n');
    ensureAgentMemoryDir(projDir);
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('local-notes/');
    expect(gitignore).toContain('cache/');
  });

  it('does not rewrite .tamtam/.gitignore when `cache/` is already present', () => {
    const gitignorePath = join(projDir, '.tamtam', '.gitignore');
    writeFileSync(gitignorePath, '# kept comment\ncache/\nother/\n');
    ensureAgentMemoryDir(projDir);
    expect(readFileSync(gitignorePath, 'utf-8')).toBe('# kept comment\ncache/\nother/\n');
  });
});

describe('buildMemoryBlock', () => {
  it('includes memory path', () => {
    const block = buildMemoryBlock('/repo/proj/.tamtam/cache/agent-memory/agent.md', null);
    expect(block).toContain('/repo/proj/.tamtam/cache/agent-memory/agent.md');
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
