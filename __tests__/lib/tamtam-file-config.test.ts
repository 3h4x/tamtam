import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadFileConfig } from '@/lib/tamtam-file-config';

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

  it('parses boolean fields', () => {
    writeConfig(tmpDir, `pr_workflow_enabled: true
auto_push_enabled: false
tests_disabled: true
review_disabled: false
issue_auto_branch: true
`);
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.pr_workflow_enabled).toBe(true);
    expect(cfg?.auto_push_enabled).toBe(false);
    expect(cfg?.tests_disabled).toBe(true);
    expect(cfg?.review_disabled).toBe(false);
    expect(cfg?.issue_auto_branch).toBe(true);
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
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('pnpm run test');
  });
});
