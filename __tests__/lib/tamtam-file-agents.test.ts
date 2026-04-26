import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanFileAgents, loadFileAgent, parseFileAgentId } from '@/lib/tamtam-file-agents';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tamtam-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgent(dir: string, name: string, content: string) {
  const agentsDir = join(dir, '.tamtam', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), content);
}

describe('parseFileAgentId', () => {
  it('returns null for non-file IDs', () => {
    expect(parseFileAgentId('agent-123')).toBeNull();
    expect(parseFileAgentId('')).toBeNull();
  });

  it('parses file:project:name', () => {
    expect(parseFileAgentId('file:tamtam:improve')).toEqual({ project: 'tamtam', name: 'improve' });
    expect(parseFileAgentId('file:my-project:docs-claude')).toEqual({ project: 'my-project', name: 'docs-claude' });
  });

  it('returns null for malformed file IDs', () => {
    expect(parseFileAgentId('file:')).toBeNull();
    expect(parseFileAgentId('file:nocodon')).toBeNull();
  });
});

describe('scanFileAgents', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty array when .tamtam/agents does not exist', () => {
    expect(scanFileAgents(tmpDir, 'myproject')).toEqual([]);
  });

  it('scans a minimal agent file (no frontmatter)', () => {
    writeAgent(tmpDir, 'simple', 'Run tests and report failures.');
    const agents = scanFileAgents(tmpDir, 'myproject');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('simple');
    expect(agents[0].id).toBe('file:myproject:simple');
    expect(agents[0].project).toBe('myproject');
    expect(agents[0].prompt).toBe('Run tests and report failures.');
    expect(agents[0].model).toBe('sonnet');
    expect(agents[0].runner).toBe('pm2');
    expect(agents[0].enabled).toBe(true);
    expect(agents[0].source).toBe('file');
    expect(agents[0].schedule).toBeNull();
    expect(agents[0].skillIds).toEqual([]);
  });

  it('parses frontmatter fields', () => {
    writeAgent(tmpDir, 'improve', `---
model: opus
schedule: 4h
runner: launchctl
enabled: true
skillIds: ["persona:engineering-team/senior-fullstack"]
---
Improve the UI of tamtam.`);
    const agents = scanFileAgents(tmpDir, 'tamtam');
    expect(agents).toHaveLength(1);
    const a = agents[0];
    expect(a.model).toBe('opus');
    expect(a.schedule).toBe('4h');
    expect(a.runner).toBe('launchctl');
    expect(a.enabled).toBe(true);
    expect(a.skillIds).toEqual(['persona:engineering-team/senior-fullstack']);
    expect(a.prompt).toBe('Improve the UI of tamtam.');
  });

  it('respects enabled: false', () => {
    writeAgent(tmpDir, 'disabled', `---
enabled: false
---
Do something.`);
    const agents = scanFileAgents(tmpDir, 'proj');
    expect(agents[0].enabled).toBe(false);
  });

  it('parses multiple agents', () => {
    writeAgent(tmpDir, 'tests', 'Run tests.');
    writeAgent(tmpDir, 'docs', 'Update docs.');
    const agents = scanFileAgents(tmpDir, 'proj');
    expect(agents).toHaveLength(2);
    const names = agents.map(a => a.name).sort();
    expect(names).toEqual(['docs', 'tests']);
  });

  it('ignores non-.md files', () => {
    const dir = join(tmpDir, '.tamtam', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    writeFileSync(join(dir, 'agent.md'), 'run this');
    const agents = scanFileAgents(tmpDir, 'proj');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('agent');
  });

  it('parses space-separated skillIds', () => {
    writeAgent(tmpDir, 'multi', `---
skillIds: agent-tests agent-docs-claude
---
Do stuff.`);
    const a = scanFileAgents(tmpDir, 'proj')[0];
    expect(a.skillIds).toEqual(['agent-tests', 'agent-docs-claude']);
  });
});

describe('loadFileAgent', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when file does not exist', () => {
    expect(loadFileAgent(tmpDir, 'proj', 'missing')).toBeNull();
  });

  it('loads an agent by name', () => {
    writeAgent(tmpDir, 'tests', `---
model: haiku
---
Run pnpm test.`);
    const a = loadFileAgent(tmpDir, 'proj', 'tests');
    expect(a).not.toBeNull();
    expect(a!.name).toBe('tests');
    expect(a!.model).toBe('haiku');
    expect(a!.prompt).toBe('Run pnpm test.');
  });
});
