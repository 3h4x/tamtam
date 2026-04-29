import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadFileConfig, writeFileConfig } from '@/lib/tamtam-file-config';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tamtam-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
});
