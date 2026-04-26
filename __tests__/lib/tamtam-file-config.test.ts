import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadFileConfig, writeFileConfig } from '@/lib/tamtam-file-config';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tamtam-cfg-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string) {
  const cfgDir = join(dir, '.tamtam');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.yml'), content);
}

describe('loadFileConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when config.yml does not exist', () => {
    expect(loadFileConfig(tmpDir)).toBeNull();
  });

  it('parses test_command', () => {
    writeConfig(tmpDir, 'test_command: pnpm test\n');
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('pnpm test');
  });

  it('parses all boolean fields', () => {
    writeConfig(tmpDir, `pr_workflow_enabled: true
auto_push_enabled: false
auto_commit_enabled: true
auto_pr_merge_enabled: false
release_after_run: true
test_cron_enabled: true
tests_disabled: true
review_disabled: false
issue_auto_branch: true
`);
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.pr_workflow_enabled).toBe(true);
    expect(cfg?.auto_push_enabled).toBe(false);
    expect(cfg?.auto_commit_enabled).toBe(true);
    expect(cfg?.auto_pr_merge_enabled).toBe(false);
    expect(cfg?.release_after_run).toBe(true);
    expect(cfg?.test_cron_enabled).toBe(true);
    expect(cfg?.tests_disabled).toBe(true);
    expect(cfg?.review_disabled).toBe(false);
    expect(cfg?.issue_auto_branch).toBe(true);
  });

  it('parses test_cron_schedule', () => {
    writeConfig(tmpDir, 'test_cron_schedule: 6h\n');
    expect(loadFileConfig(tmpDir)?.test_cron_schedule).toBe('6h');
  });

  it('ignores comments and blank lines', () => {
    writeConfig(tmpDir, `# pipeline config
test_command: npm test

# disable auto push
auto_push_enabled: false
`);
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('npm test');
    expect(cfg?.auto_push_enabled).toBe(false);
  });

  it('returns null for empty config', () => {
    writeConfig(tmpDir, '# just comments\n');
    expect(loadFileConfig(tmpDir)).toBeNull();
  });

  it('strips quotes from test_command', () => {
    writeConfig(tmpDir, 'test_command: "pnpm run test"\n');
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm run test');
  });

  it('parses grouped format (indented keys under section headers)', () => {
    writeConfig(tmpDir, `# TamTam project configuration
# See .tamtam/agents/ for agent definitions

pipeline:
  test_command: pnpm lint && pnpm test
  auto_commit_enabled: true
  auto_push_enabled: true
  release_after_run: true

schedule:
  test_cron_enabled: true
  test_cron_schedule: 6h

gates:
  tests_disabled: false
  review_disabled: true
  issue_auto_branch: true
`);
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('pnpm lint && pnpm test');
    expect(cfg?.auto_commit_enabled).toBe(true);
    expect(cfg?.auto_push_enabled).toBe(true);
    expect(cfg?.release_after_run).toBe(true);
    expect(cfg?.test_cron_enabled).toBe(true);
    expect(cfg?.test_cron_schedule).toBe('6h');
    expect(cfg?.tests_disabled).toBe(false);
    expect(cfg?.review_disabled).toBe(true);
    expect(cfg?.issue_auto_branch).toBe(true);
  });

  it('returns null for a file containing only group headers', () => {
    writeConfig(tmpDir, 'pipeline:\nschedule:\ngates:\n');
    expect(loadFileConfig(tmpDir)).toBeNull();
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
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('test_command: pnpm test');
  });

  it('includes header comment', () => {
    writeFileConfig(tmpDir, { auto_push_enabled: false });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('# TamTam project configuration');
  });

  it('merges into existing config without losing unrelated keys', () => {
    writeConfig(tmpDir, 'test_command: npm test\nauto_push_enabled: false\n');
    writeFileConfig(tmpDir, { pr_workflow_enabled: true });
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('npm test');
    expect(cfg?.auto_push_enabled).toBe(false);
    expect(cfg?.pr_workflow_enabled).toBe(true);
  });

  it('updates existing key', () => {
    writeConfig(tmpDir, 'test_command: npm test\n');
    writeFileConfig(tmpDir, { test_command: 'pnpm test' });
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm test');
  });

  it('removes key when set to null', () => {
    writeConfig(tmpDir, 'test_command: npm test\nauto_push_enabled: true\n');
    writeFileConfig(tmpDir, { test_command: null });
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBeUndefined();
    expect(cfg?.auto_push_enabled).toBe(true);
  });

  it('writes keys in canonical order', () => {
    writeFileConfig(tmpDir, {
      auto_push_enabled: true,
      test_command: 'pnpm test',
      pr_workflow_enabled: true,
    });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    const lines = content.split('\n').filter(l => l && !l.startsWith('#'));
    const keyOrder = lines.map(l => l.split(':')[0].trim());
    expect(keyOrder.indexOf('test_command')).toBeLessThan(keyOrder.indexOf('pr_workflow_enabled'));
    expect(keyOrder.indexOf('pr_workflow_enabled')).toBeLessThan(keyOrder.indexOf('auto_push_enabled'));
  });

  it('creates .tamtam dir if not present', () => {
    writeFileConfig(tmpDir, { tests_disabled: true });
    expect(existsSync(join(tmpDir, '.tamtam', 'config.yml'))).toBe(true);
  });

  it('emits grouped sections in output', () => {
    writeFileConfig(tmpDir, {
      test_command: 'pnpm test',
      auto_push_enabled: true,
      test_cron_enabled: true,
      tests_disabled: false,
    });
    const content = readFileSync(join(tmpDir, '.tamtam', 'config.yml'), 'utf-8');
    expect(content).toContain('pipeline:');
    expect(content).toContain('  test_command: pnpm test');
    expect(content).toContain('  auto_push_enabled: true');
    expect(content).toContain('schedule:');
    expect(content).toContain('  test_cron_enabled: true');
    expect(content).toContain('gates:');
    expect(content).toContain('  tests_disabled: false');
  });

  it('round-trips grouped format through write then load', () => {
    writeFileConfig(tmpDir, {
      test_command: 'pnpm test',
      pr_workflow_enabled: true,
      test_cron_schedule: '4h',
      review_disabled: true,
    });
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('pnpm test');
    expect(cfg?.pr_workflow_enabled).toBe(true);
    expect(cfg?.test_cron_schedule).toBe('4h');
    expect(cfg?.review_disabled).toBe(true);
  });

  it('merges grouped format input without losing keys', () => {
    writeConfig(tmpDir, `pipeline:\n  test_command: npm test\n  auto_push_enabled: false\n`);
    writeFileConfig(tmpDir, { pr_workflow_enabled: true });
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('npm test');
    expect(cfg?.auto_push_enabled).toBe(false);
    expect(cfg?.pr_workflow_enabled).toBe(true);
  });
});
