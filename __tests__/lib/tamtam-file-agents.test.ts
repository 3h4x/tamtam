import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock git-branch so scanFileAgents / loadFileAgent / writeFileAgent don't
// spawn `git` subprocesses per call against tmp dirs that aren't real repos.
// Branch-aware behavior is covered separately by
// __tests__/lib/tamtam-file-agents-branch.test.ts; here we exercise the
// default-branch (working-tree) read/write paths and one explicit feature-branch
// scenario that re-mocks git-branch for itself.
vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: vi.fn(() => ({
    currentBranch: 'main',
    defaultBranch: 'main',
    isDefaultBranch: true,
  })),
  gitShowSync: vi.fn(() => null),
  gitLsTreeSync: vi.fn(() => []),
  getDefaultBranchSync: vi.fn(() => 'main'),
  getCurrentBranchSync: vi.fn(() => 'main'),
}));

// Mock file-agent-overrides so buildFileAgent doesn't kick off background DB
// reads via the sync stale-while-revalidate cache.
vi.mock('@/lib/agents/file-agent-overrides', () => ({
  getFileAgentOverride: vi.fn().mockResolvedValue(null),
  getFileAgentOverrideSync: vi.fn().mockReturnValue(null),
}));

import { scanFileAgents, loadFileAgent, parseFileAgentId, renameFileAgent, writeFileAgent } from '@/lib/agents/tamtam-file-agents';

let rootTmpDir: string;
let tmpCounter = 0;

function makeTmpDir(): string {
  const dir = join(rootTmpDir, `p-${++tmpCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgent(dir: string, name: string, content: string) {
  const agentsDir = join(dir, '.tamtam', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), content);
}

beforeAll(() => {
  rootTmpDir = join(tmpdir(), `tamtam-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rootTmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true });
});

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
    expect(agents[0].model).toBe('normal');
    expect(agents[0].runner).toBe('pm2');
    expect(agents[0].enabled).toBe(true);
    expect(agents[0].source).toBe('file');
    expect(agents[0].schedule).toBeNull();
    expect(agents[0].skillIds).toEqual([]);
  });

  it('parses frontmatter fields', () => {
    writeAgent(tmpDir, 'improve', `---
provider: codex
model: opus
schedule: 4h
runner: launchctl
enabled: true
skillIds: ["persona:engineering-team/senior-fullstack"]
---
Improve the UI of tamtam.`);
    const agents = scanFileAgents(tmpDir, 'testproject');
    expect(agents).toHaveLength(1);
    const a = agents[0];
    expect(a.provider).toBe('codex');
    expect(a.model).toBe('smart');
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

  it('defaults prerequisiteCommand to null when absent', () => {
    writeAgent(tmpDir, 'plain', 'Do stuff.');
    const a = scanFileAgents(tmpDir, 'proj')[0];
    expect(a.prerequisiteCommand).toBeNull();
  });

  it('parses prerequisiteCommand from frontmatter (JSON-quoted)', () => {
    writeAgent(tmpDir, 'tests-watcher', `---
prerequisiteCommand: "pnpm test --reporter=basic"
---
Look at how slow tests are.`);
    const a = scanFileAgents(tmpDir, 'proj')[0];
    expect(a.prerequisiteCommand).toBe('pnpm test --reporter=basic');
  });

  it('preserves an explicitly cleared prerequisiteCommand from frontmatter', () => {
    writeAgent(tmpDir, 'tests-watcher', `---
prerequisiteCommand: ""
---
Look at how slow tests are.`);
    const a = scanFileAgents(tmpDir, 'proj')[0];
    expect(a.prerequisiteCommand).toBe('');
  });

  it('parses prerequisiteCommand without quotes when no special characters', () => {
    writeAgent(tmpDir, 'simple-prereq', `---
prerequisiteCommand: pnpm test
---
Body.`);
    const a = scanFileAgents(tmpDir, 'proj')[0];
    expect(a.prerequisiteCommand).toBe('pnpm test');
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
    expect(a!.model).toBe('fast');
    expect(a!.prompt).toBe('Run pnpm test.');
  });

  it('sanitizes invalid frontmatter models back to normal', () => {
    writeAgent(tmpDir, 'tests', `---
model: smart --resume injected
---
Run pnpm test.`);
    const a = loadFileAgent(tmpDir, 'proj', 'tests');
    expect(a).not.toBeNull();
    expect(a!.model).toBe('normal');
  });
});

describe('writeFileAgent', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates .tamtam/agents/<name>.md when it does not exist', () => {
    writeFileAgent(tmpDir, 'proj', 'new-agent', { prompt: 'Do something.', model: 'normal' });
    const filePath = join(tmpDir, '.tamtam', 'agents', 'new-agent.md');
    expect(existsSync(filePath)).toBe(true);
  });

  it('returns a FileAgent with source: file', () => {
    const a = writeFileAgent(tmpDir, 'proj', 'improve', { prompt: 'Fix UI.', model: 'smart' });
    expect(a.source).toBe('file');
    expect(a.name).toBe('improve');
    expect(a.model).toBe('smart');
    expect(a.prompt).toBe('Fix UI.');
    expect(a.id).toBe('file:proj:improve');
  });

  it('merges into existing file without losing unset fields', () => {
    writeAgent(tmpDir, 'improve', `---
provider: gemini
model: opus
schedule: 4h
skillIds: ["agent-tests"]
---
Original prompt.`);

    writeFileAgent(tmpDir, 'proj', 'improve', { prompt: 'Updated prompt.' });

    const a = loadFileAgent(tmpDir, 'proj', 'improve');
    expect(a!.prompt).toBe('Updated prompt.');
    expect(a!.provider).toBe('gemini');
    expect(a!.model).toBe('smart');
    expect(a!.schedule).toBe('4h');
    expect(a!.skillIds).toEqual(['agent-tests']);
  });

  it('updates model when provided', () => {
    writeAgent(tmpDir, 'agent', `---\nmodel: sonnet\n---\nDo stuff.`);
    writeFileAgent(tmpDir, 'proj', 'agent', { model: 'haiku' });
    expect(loadFileAgent(tmpDir, 'proj', 'agent')!.model).toBe('fast');
  });

  it('clears schedule when set to null', () => {
    writeAgent(tmpDir, 'agent', `---\nmodel: sonnet\nschedule: 4h\n---\nDo stuff.`);
    writeFileAgent(tmpDir, 'proj', 'agent', { schedule: null });
    expect(loadFileAgent(tmpDir, 'proj', 'agent')!.schedule).toBeNull();
  });

  it('rejects invalid schedules when writing frontmatter', () => {
    expect(() => writeFileAgent(tmpDir, 'proj', 'agent', { schedule: '1w' })).toThrow('Invalid schedule');
    expect(existsSync(join(tmpDir, '.tamtam', 'agents', 'agent.md'))).toBe(false);
  });

  it('writes runner only when not pm2', () => {
    writeFileAgent(tmpDir, 'proj', 'agent', { runner: 'launchctl' });
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'agent.md'), 'utf-8');
    expect(content).toContain('runner: launchctl');

    writeFileAgent(tmpDir, 'proj', 'agent2', { runner: 'pm2' });
    const content2 = readFileSync(join(tmpDir, '.tamtam', 'agents', 'agent2.md'), 'utf-8');
    expect(content2).not.toContain('runner:');
  });

  it('round-trips prerequisiteCommand through write + load', () => {
    writeFileAgent(tmpDir, 'proj', 'tester', {
      prompt: 'Watch test speed.',
      prerequisiteCommand: 'pnpm test',
    });
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'tester.md'), 'utf-8');
    expect(content).toContain('prerequisiteCommand:');
    const a = loadFileAgent(tmpDir, 'proj', 'tester');
    expect(a!.prerequisiteCommand).toBe('pnpm test');
  });

  it('clears prerequisiteCommand when set to null', () => {
    writeFileAgent(tmpDir, 'proj', 'tester', {
      prompt: 'x',
      prerequisiteCommand: 'pnpm test',
    });
    writeFileAgent(tmpDir, 'proj', 'tester', { prerequisiteCommand: null });
    const a = loadFileAgent(tmpDir, 'proj', 'tester');
    expect(a!.prerequisiteCommand).toBeNull();
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'tester.md'), 'utf-8');
    expect(content).not.toContain('prerequisiteCommand:');
  });

  it('round-trips an explicitly cleared prerequisiteCommand sentinel', () => {
    writeFileAgent(tmpDir, 'proj', 'tester', {
      prompt: 'x',
      prerequisiteCommand: '',
    });
    const a = loadFileAgent(tmpDir, 'proj', 'tester');
    expect(a!.prerequisiteCommand).toBe('');
    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'tester.md'), 'utf-8');
    expect(content).toContain('prerequisiteCommand: ""');
  });

  it('preserves prerequisiteCommand when other fields are updated', () => {
    writeFileAgent(tmpDir, 'proj', 'tester', {
      prompt: 'x',
      prerequisiteCommand: 'pnpm test --reporter=basic',
    });
    writeFileAgent(tmpDir, 'proj', 'tester', { model: 'smart' });
    const a = loadFileAgent(tmpDir, 'proj', 'tester');
    expect(a!.prerequisiteCommand).toBe('pnpm test --reporter=basic');
    expect(a!.model).toBe('smart');
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
      provider: 'lmstudio',
      model: 'smart', schedule: '8h', skillIds, runner: 'launchctl', prompt: 'Run stuff.',
    });
    const a = loadFileAgent(tmpDir, 'proj', 'agent')!;
    expect(a.provider).toBe('lmstudio');
    expect(a.model).toBe('smart');
    expect(a.schedule).toBe('8h');
    expect(a.skillIds).toEqual(skillIds);
    expect(a.runner).toBe('launchctl');
    expect(a.prompt).toBe('Run stuff.');
  });

  it('preserves an existing provider on prompt-only writes', () => {
    writeAgent(tmpDir, 'provider-agent', `---
provider: codex
model: normal
---
Original prompt.`);

    writeFileAgent(tmpDir, 'proj', 'provider-agent', { prompt: 'Updated prompt.' });

    const content = readFileSync(join(tmpDir, '.tamtam', 'agents', 'provider-agent.md'), 'utf-8');
    expect(content).toContain('provider: codex');
    expect(loadFileAgent(tmpDir, 'proj', 'provider-agent')!.provider).toBe('codex');
  });
});

describe('renameFileAgent', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('renames a file-backed agent and preserves updated content', () => {
    writeAgent(tmpDir, 'Self', `---
model: normal
---
Original prompt.`);

    const updated = renameFileAgent(tmpDir, 'proj', 'Self', 'Renamed', {
      prompt: 'Renamed prompt.',
    });
    const files = readdirSync(join(tmpDir, '.tamtam', 'agents')).sort();

    expect(updated.name).toBe('Renamed');
    expect(files).toEqual(['Renamed.md']);
    expect(loadFileAgent(tmpDir, 'proj', 'Renamed')!.prompt).toBe('Renamed prompt.');
  });

  it('handles case-only renames without deleting the agent file', () => {
    writeAgent(tmpDir, 'Self', `---
model: normal
---
Original prompt.`);

    const updated = renameFileAgent(tmpDir, 'proj', 'Self', 'self', {
      prompt: 'Case-only rename prompt.',
    });
    const files = readdirSync(join(tmpDir, '.tamtam', 'agents')).sort();

    expect(updated.name).toBe('self');
    expect(files).toEqual(['self.md']);
    expect(loadFileAgent(tmpDir, 'proj', 'self')!.prompt).toBe('Case-only rename prompt.');
  });
});

describe('writeFileAgent on feature branches', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => {
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves the default-branch prompt on provider-only writes when no working-tree file exists', async () => {
    vi.resetModules();
    vi.doMock('@/lib/git/git-branch', () => ({
      getBranchContext: vi.fn().mockReturnValue({ isDefaultBranch: false, defaultBranch: 'main' }),
      gitLsTreeSync: vi.fn(),
      gitShowSync: vi.fn().mockReturnValue(`---
provider: claude
model: normal
---
Prompt from default branch.`),
    }));
    vi.doMock('@/lib/agents/file-agent-overrides', () => ({
      getFileAgentOverride: vi.fn().mockResolvedValue(null),
      getFileAgentOverrideSync: vi.fn().mockReturnValue(null),
    }));

    const mod = await import('@/lib/agents/tamtam-file-agents');
    const updated = mod.writeFileAgent(tmpDir, 'proj', 'branch-agent', { provider: 'codex' });

    expect(updated.prompt).toBe('Prompt from default branch.');
    expect(updated.provider).toBe('codex');
    expect(readFileSync(join(tmpDir, '.tamtam', 'agents', 'branch-agent.md'), 'utf-8')).toContain('Prompt from default branch.');
    expect(mod.loadFileAgent(tmpDir, 'proj', 'branch-agent')!.prompt).toBe('Prompt from default branch.');
  });
});
