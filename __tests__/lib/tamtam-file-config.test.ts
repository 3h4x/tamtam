import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock git-branch so loadFileConfig / writeFileConfig don't spawn `git`
// subprocesses per call. Branch-aware behavior is covered separately by
// __tests__/lib/tamtam-file-config-branch.test.ts; here we only need the
// default-branch (working-tree) read/write path.
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

import { loadFileConfig, writeFileConfig } from '@/lib/skills/tamtam-file-config';

let rootTmpDir: string;
let tmpCounter = 0;

function makeTmpDir(): string {
  const dir = join(rootTmpDir, `p-${++tmpCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string) {
  const cfgDir = join(dir, '.tamtam');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.yml'), content);
}

// `.tamtam/config.yml` is the team contract: only test_command, custom_actions
// and safe_users live here. Workflow flags (auto_push, pr_workflow, gates,
// cron) are DB-only so each developer can opt in independently.

beforeAll(() => {
  rootTmpDir = join(tmpdir(), `tamtam-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rootTmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true });
});

describe('loadFileConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when config.yml does not exist', () => {
    expect(loadFileConfig(tmpDir)).toBeNull();
  });

  it('parses test_command', () => {
    writeConfig(tmpDir, 'test_command: pnpm test\n');
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm test');
  });

  it('strips quotes from test_command', () => {
    writeConfig(tmpDir, 'test_command: "pnpm run test"\n');
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm run test');
  });

  it('ignores comments and blank lines', () => {
    writeConfig(tmpDir, `# project config
test_command: npm test

# trailing comment
`);
    expect(loadFileConfig(tmpDir)?.test_command).toBe('npm test');
  });

  it('returns null for empty config', () => {
    writeConfig(tmpDir, '# just comments\n');
    expect(loadFileConfig(tmpDir)).toBeNull();
  });

  it('parses grouped format (test_command under pipeline)', () => {
    writeConfig(tmpDir, `pipeline:
  test_command: pnpm lint && pnpm test
`);
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm lint && pnpm test');
  });

  it('ignores legacy workflow flags on read (DB is authoritative)', () => {
    writeConfig(tmpDir, `pipeline:
  test_command: pnpm test
  auto_commit_enabled: true
  auto_push_enabled: true
  release_after_run: true
schedule:
  test_cron_enabled: true
  test_cron_schedule: 6h
gates:
  tests_disabled: true
  review_disabled: true
  issue_auto_branch: false
`);
    const cfg = loadFileConfig(tmpDir) as Record<string, unknown> | null;
    expect(cfg?.test_command).toBe('pnpm test');
    // Workflow / schedule / gate flags are no longer part of the file contract.
    expect(cfg?.auto_commit_enabled).toBeUndefined();
    expect(cfg?.auto_push_enabled).toBeUndefined();
    expect(cfg?.release_after_run).toBeUndefined();
    expect(cfg?.test_cron_enabled).toBeUndefined();
    expect(cfg?.test_cron_schedule).toBeUndefined();
    expect(cfg?.tests_disabled).toBeUndefined();
    expect(cfg?.review_disabled).toBeUndefined();
    expect(cfg?.issue_auto_branch).toBeUndefined();
  });

  it('parses safe_users inline array', () => {
    writeConfig(tmpDir, 'security:\n  safe_users: [alice, bob]\n');
    expect(loadFileConfig(tmpDir)?.safe_users).toEqual(['alice', 'bob']);
  });

  it('parses safe_users block array', () => {
    writeConfig(tmpDir, 'security:\n  safe_users:\n    - alice\n    - "dependabot[bot]"\n');
    expect(loadFileConfig(tmpDir)?.safe_users).toEqual(['alice', 'dependabot[bot]']);
  });

  it('parses empty safe_users array', () => {
    writeConfig(tmpDir, 'security:\n  safe_users: []\n');
    expect(loadFileConfig(tmpDir)?.safe_users).toEqual([]);
  });

  it('ignores safe_users when not an array of strings', () => {
    writeConfig(tmpDir, 'security:\n  safe_users: not-an-array\n');
    expect(loadFileConfig(tmpDir)?.safe_users).toBeUndefined();
  });

  it('parses custom_actions list', () => {
    writeConfig(tmpDir, `actions:
  custom_actions:
    - name: deploy
      command: ./scripts/deploy.sh
      color: green
    - name: lint
      command: pnpm lint
`);
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.custom_actions).toEqual([
      { name: 'deploy', command: './scripts/deploy.sh', color: 'green' },
      { name: 'lint', command: 'pnpm lint' },
    ]);
  });

  it('parses commit_style at the top level', () => {
    writeConfig(tmpDir, 'commit_style: |\n  Use cyberpunk vocabulary.\n  No periods.\n');
    expect(loadFileConfig(tmpDir)?.commit_style).toBe('Use cyberpunk vocabulary.\nNo periods.\n');
  });

  it('parses commit_style under the commits group', () => {
    writeConfig(tmpDir, 'commits:\n  commit_style: "feat: <cryptic>"\n');
    expect(loadFileConfig(tmpDir)?.commit_style).toBe('feat: <cryptic>');
  });

  it('writes commit_style under the commits group and round-trips', () => {
    writeFileConfig(tmpDir, { commit_style: 'cyberpunk only' });
    const raw = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(raw).toContain('commits:');
    expect(raw).toContain('commit_style: cyberpunk only');
    expect(loadFileConfig(tmpDir)?.commit_style).toBe('cyberpunk only');
  });

  it('removes commit_style when written as null', () => {
    writeFileConfig(tmpDir, { commit_style: 'first style' });
    writeFileConfig(tmpDir, { commit_style: null });
    expect(loadFileConfig(tmpDir)?.commit_style).toBeUndefined();
  });

  it('drops custom_actions entries missing name or command', () => {
    writeConfig(tmpDir, `custom_actions:
  - name: ok
    command: echo ok
  - name: missing-command
  - command: missing-name
`);
    expect(loadFileConfig(tmpDir)?.custom_actions).toEqual([
      { name: 'ok', command: 'echo ok' },
    ]);
  });
});

describe('writeFileConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates .tamtam/config.yml when it does not exist', () => {
    writeFileConfig(tmpDir, { test_command: 'pnpm test' });
    const configPath = join(tmpDir, '.tamtam', 'config.yml');
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('test_command: pnpm test');
  });

  it('includes header comment', () => {
    writeFileConfig(tmpDir, { test_command: 'pnpm test' });
    expect(readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8')).toContain('# TamTam project configuration');
  });

  it('updates existing key', () => {
    writeConfig(tmpDir, 'test_command: npm test\n');
    writeFileConfig(tmpDir, { test_command: 'pnpm test' });
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm test');
  });

  it('removes key when set to null', () => {
    writeConfig(tmpDir, 'test_command: npm test\n');
    writeFileConfig(tmpDir, { test_command: null });
    expect(loadFileConfig(tmpDir)?.test_command).toBeUndefined();
  });

  it('writes safe_users under security section', () => {
    writeFileConfig(tmpDir, { safe_users: ['alice', 'bob'] });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('security:');
    expect(content).toContain('alice');
    expect(content).toContain('bob');
  });

  it('round-trips safe_users through write then load', () => {
    writeFileConfig(tmpDir, { safe_users: ['owner', 'dependabot[bot]'] });
    expect(loadFileConfig(tmpDir)?.safe_users).toEqual(['owner', 'dependabot[bot]']);
  });

  it('writes custom_actions and round-trips them', () => {
    const actions = [
      { name: 'deploy', command: './scripts/deploy.sh', color: 'green' },
      { name: 'lint', command: 'pnpm lint' },
    ];
    writeFileConfig(tmpDir, { custom_actions: actions });
    expect(loadFileConfig(tmpDir)?.custom_actions).toEqual(actions);
  });

  it('removes custom_actions when set to null', () => {
    writeFileConfig(tmpDir, { custom_actions: [{ name: 'x', command: 'y' }] });
    writeFileConfig(tmpDir, { custom_actions: null });
    expect(loadFileConfig(tmpDir)?.custom_actions).toBeUndefined();
  });

  it('removes safe_users when set to null', () => {
    writeConfig(tmpDir, 'security:\n  safe_users:\n    - alice\n');
    writeFileConfig(tmpDir, { safe_users: null });
    expect(loadFileConfig(tmpDir)?.safe_users).toBeUndefined();
  });

  it('preserves unknown top-level keys through write', () => {
    writeConfig(tmpDir, 'pipeline:\n  test_command: pnpm test\ncustom_section:\n  foo: bar\n');
    writeFileConfig(tmpDir, { safe_users: ['owner'] });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('custom_section');
    expect(content).toContain('foo');
    expect(content).toContain('bar');
  });

  it('preserves unknown commits keys when writing unrelated fields', () => {
    writeConfig(tmpDir, 'commits:\n  template: ticket-first\n');
    writeFileConfig(tmpDir, { test_command: 'pnpm test' });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('commits:');
    expect(content).toContain('template: ticket-first');
  });

  it('preserves unknown commits keys when updating commit_style', () => {
    writeConfig(tmpDir, 'commits:\n  template: ticket-first\n  commit_style: old style\n');
    writeFileConfig(tmpDir, { commit_style: 'new style' });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('template: ticket-first');
    expect(content).toContain('commit_style: new style');
  });

  it('preserves unknown commits keys when removing commit_style', () => {
    writeConfig(tmpDir, 'commits:\n  template: ticket-first\n  commit_style: old style\n');
    writeFileConfig(tmpDir, { commit_style: null });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('commits:');
    expect(content).toContain('template: ticket-first');
    expect(content).not.toContain('commit_style:');
  });
});
