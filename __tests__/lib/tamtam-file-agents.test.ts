import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanFileAgents, loadFileAgent, parseFileAgentId, writeFileAgent } from '@/lib/agents/tamtam-file-agents';

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

describe('writeFileAgent', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates .tamtam/agents/<name>.md when it does not exist', () => {
    writeFileAgent(tmpDir, 'proj', 'new-agent', { prompt: 'Do something.', model: 'sonnet' });
    const filePath = join(tmpDir, '.tamtam', 'agents', 'new-agent.md');
    expect(existsSync(filePath)).toBe(true);
  });

  it('returns a FileAgent with source: file', () => {
    const a = writeFileAgent(tmpDir, 'proj', 'improve', { prompt: 'Fix UI.', model: 'opus' });
    expect(a.source).toBe('file');
    expect(a.name).toBe('improve');
    expect(a.model).toBe('opus');
    expect(a.prompt).toBe('Fix UI.');
    expect(a.id).toBe('file:proj:improve');
  });

  it('merges into existing file without losing unset fields', () => {
    writeAgent(tmpDir, 'improve', `---
model: opus
schedule: 4h
skillIds: ["agent-tests"]
---
Original prompt.`);

    writeFileAgent(tmpDir, 'proj', 'improve', { prompt: 'Updated prompt.' });

    const a = loadFileAgent(tmpDir, 'proj', 'improve');
    expect(a!.prompt).toBe('Updated prompt.');
    expect(a!.model).toBe('opus');
    expect(a!.schedule).toBe('4h');
    expect(a!.skillIds).toEqual(['agent-tests']);
  });

  it('updates model when provided', () => {
    writeAgent(tmpDir, 'agent', `---\nmodel: sonnet\n---\nDo stuff.`);
    writeFileAgent(tmpDir, 'proj', 'agent', { model: 'haiku' });
    expect(loadFileAgent(tmpDir, 'proj', 'agent')!.model).toBe('haiku');
  });

  it('clears schedule when set to null', () => {
    writeAgent(tmpDir, 'agent', `---\nmodel: sonnet\nschedule: 4h\n---\nDo stuff.`);
    writeFileAgent(tmpDir, 'proj', 'agent', { schedule: null });
    expect(loadFileAgent(tmpDir, 'proj', 'agent')!.schedule).toBeNull();
  });

  it('writes runner only when not pm2', () => {
    writeFileAgent(tmpDir, 'proj', 'agent', { runner: 'launchctl' });
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'agent.md'), 'utf-8');
    expect(content).toContain('runner: launchctl');

    writeFileAgent(tmpDir, 'proj', 'agent2', { runner: 'pm2' });
    const content2 = readFileSync(join(tmpDir, '.tamtam', 'agents', 'agent2.md'), 'utf-8');
    expect(content2).not.toContain('runner:');
  });

  it('writes enabled: false only when disabled', () => {
    writeFileAgent(tmpDir, 'proj', 'off', { enabled: false });
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'off.md'), 'utf-8');
    expect(content).toContain('enabled: false');

    writeFileAgent(tmpDir, 'proj', 'on', { enabled: true });
    const content2 = readFileSync(join(tmpDir, '.tamtam', 'agents', 'on.md'), 'utf-8');
    expect(content2).not.toContain('enabled:');
  });

  it('creates .tamtam/agents dir when missing', () => {
    writeFileAgent(tmpDir, 'proj', 'x', {});
    expect(existsSync(join(tmpDir, '.tamtam', 'agents', 'x.md'))).toBe(true);
  });

  it('round-trips through load', () => {
    const skillIds = ['persona:engineering-team/senior-fullstack', 'agent-tests'];
    writeFileAgent(tmpDir, 'proj', 'agent', {
      model: 'opus', schedule: '8h', skillIds, runner: 'launchctl', prompt: 'Run stuff.',
    });
    const a = loadFileAgent(tmpDir, 'proj', 'agent')!;
    expect(a.model).toBe('opus');
    expect(a.schedule).toBe('8h');
    expect(a.skillIds).toEqual(skillIds);
    expect(a.runner).toBe('launchctl');
    expect(a.prompt).toBe('Run stuff.');
  });
});
