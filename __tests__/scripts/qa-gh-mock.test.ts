import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GH_MOCK = resolve(__dirname, '..', '..', 'scripts', 'qa-mocks', 'gh');

function runGh(args: string[], cwd?: string) {
  return spawnSync(GH_MOCK, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
}

describe('scripts/qa-mocks/gh', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-gh-mock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns version string', () => {
    const result = runGh(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('gh version qa-mock');
  });

  describe('repo view', () => {
    it('returns JSON with nameWithOwner when no filter flags', () => {
      const result = runGh(['repo', 'view']);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nameWithOwner).toBe('qa/mock-repo');
    });

    it('returns just the owner/repo string with --jq flag', () => {
      const result = runGh(['repo', 'view', '--jq', '.nameWithOwner']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('qa/mock-repo');
    });

    it('returns just the owner/repo string with -q flag', () => {
      const result = runGh(['repo', 'view', '-q', '.nameWithOwner']);
      expect(result.stdout.trim()).toBe('qa/mock-repo');
    });
  });

  describe('pr commands', () => {
    it('pr list returns array with expected PR shape', () => {
      const result = runGh(['pr', 'list']);
      const prs = JSON.parse(result.stdout);
      expect(Array.isArray(prs)).toBe(true);
      expect(prs[0]).toMatchObject({
        number: 12,
        headRefName: 'feature/qa-dashboard',
        url: expect.stringContaining('pull/12'),
      });
    });

    it('pr view returns PR details with mergeStateStatus', () => {
      const result = runGh(['pr', 'view', '12']);
      const pr = JSON.parse(result.stdout);
      expect(pr.number).toBe(12);
      expect(pr.mergeStateStatus).toBe('CLEAN');
      expect(pr.reviewDecision).toBe('APPROVED');
    });

    it('pr create returns a PR URL', () => {
      const result = runGh(['pr', 'create', '--title', 'Test PR']);
      expect(result.stdout.trim()).toContain('pull/12');
    });

    it('pr diff returns a diff string', () => {
      const result = runGh(['pr', 'diff', '12']);
      expect(result.stdout).toContain('diff --git');
      expect(result.stdout).toContain('+qa change');
    });
  });

  describe('issue commands', () => {
    it('issue list returns array with tamtam-labelled issues', () => {
      const result = runGh(['issue', 'list']);
      const issues = JSON.parse(result.stdout);
      expect(Array.isArray(issues)).toBe(true);
      expect(issues[0].number).toBe(34);
      expect(issues[0].labels[0].name).toBe('tamtam');
    });

    it('issue view returns issue details', () => {
      const result = runGh(['issue', 'view', '34']);
      const issue = JSON.parse(result.stdout);
      expect(issue.number).toBe(34);
      expect(issue.state).toBe('OPEN');
    });

    it('issue create returns a URL', () => {
      const result = runGh(['issue', 'create', '--title', 'Test issue']);
      expect(result.stdout.trim()).toContain('issues/35');
    });

    it('issue close returns a URL', () => {
      const result = runGh(['issue', 'close', '34']);
      expect(result.stdout.trim()).toContain('issues/');
    });
  });

  describe('label and run commands', () => {
    it('label list returns available labels array', () => {
      const result = runGh(['label', 'list']);
      const labels = JSON.parse(result.stdout);
      expect(labels.map((l: { name: string }) => l.name)).toContain('tamtam');
      expect(labels.map((l: { name: string }) => l.name)).toContain('review-followup');
    });

    it('run view returns mocked log output', () => {
      const result = runGh(['run', 'view', '42']);
      expect(result.stdout).toContain('QA failed log line');
      expect(result.stdout).toContain('QA mocked run output');
    });
  });

  it('returns empty JSON object for unknown subcommands', () => {
    const result = runGh(['unknown', 'subcommand']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('writes a qa-state.json if present in cwd for context (repo view)', () => {
    writeFileSync(join(dir, '.qa-state.json'), JSON.stringify({ github: 'qa/custom-repo' }, null, 2));
    // gh mock reads .qa-state.json for git mock but gh mock uses hardcoded values
    // repo view always returns qa/mock-repo (no cwd-based override)
    const result = runGh(['repo', 'view'], dir);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.nameWithOwner).toBe('qa/mock-repo');
  });
});
