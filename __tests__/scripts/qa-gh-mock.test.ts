import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GH_MOCK = resolve(__dirname, '..', '..', 'scripts', 'qa-mocks', 'gh');

function runGh(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(GH_MOCK, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

describe('scripts/qa-mocks/gh', () => {
  it.concurrent('returns version string', async () => {
    const result = await runGh(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('gh version qa-mock');
  });

  describe('repo view', () => {
    it.concurrent('returns JSON with nameWithOwner when no filter flags', async () => {
      const result = await runGh(['repo', 'view']);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nameWithOwner).toBe('qa/mock-repo');
    });

    it.concurrent('returns just the owner/repo string with --jq flag', async () => {
      const result = await runGh(['repo', 'view', '--jq', '.nameWithOwner']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('qa/mock-repo');
    });

    it.concurrent('returns just the owner/repo string with -q flag', async () => {
      const result = await runGh(['repo', 'view', '-q', '.nameWithOwner']);
      expect(result.stdout.trim()).toBe('qa/mock-repo');
    });
  });

  describe('pr commands', () => {
    it.concurrent('pr list returns array with expected PR shape', async () => {
      const result = await runGh(['pr', 'list']);
      const prs = JSON.parse(result.stdout);
      expect(Array.isArray(prs)).toBe(true);
      expect(prs[0]).toMatchObject({
        number: 12,
        headRefName: 'feature/qa-dashboard',
        url: expect.stringContaining('pull/12'),
      });
    });

    it.concurrent('pr view returns PR details with mergeStateStatus', async () => {
      const result = await runGh(['pr', 'view', '12']);
      const pr = JSON.parse(result.stdout);
      expect(pr.number).toBe(12);
      expect(pr.mergeStateStatus).toBe('CLEAN');
      expect(pr.reviewDecision).toBe('APPROVED');
    });

    it.concurrent('pr create returns a PR URL', async () => {
      const result = await runGh(['pr', 'create', '--title', 'Test PR']);
      expect(result.stdout.trim()).toContain('pull/12');
    });

    it.concurrent('pr diff returns a diff string', async () => {
      const result = await runGh(['pr', 'diff', '12']);
      expect(result.stdout).toContain('diff --git');
      expect(result.stdout).toContain('+qa change');
    });
  });

  describe('issue commands', () => {
    it.concurrent('issue list returns array with tamtam-labelled issues', async () => {
      const result = await runGh(['issue', 'list']);
      const issues = JSON.parse(result.stdout);
      expect(Array.isArray(issues)).toBe(true);
      expect(issues[0].number).toBe(34);
      expect(issues[0].labels[0].name).toBe('tamtam');
    });

    it.concurrent('issue view returns issue details', async () => {
      const result = await runGh(['issue', 'view', '34']);
      const issue = JSON.parse(result.stdout);
      expect(issue.number).toBe(34);
      expect(issue.state).toBe('OPEN');
    });

    it.concurrent('issue create returns a URL', async () => {
      const result = await runGh(['issue', 'create', '--title', 'Test issue']);
      expect(result.stdout.trim()).toContain('issues/35');
    });

    it.concurrent('issue close returns a URL', async () => {
      const result = await runGh(['issue', 'close', '34']);
      expect(result.stdout.trim()).toContain('issues/');
    });
  });

  describe('label and run commands', () => {
    it.concurrent('label list returns available labels array', async () => {
      const result = await runGh(['label', 'list']);
      const labels = JSON.parse(result.stdout);
      expect(labels.map((l: { name: string }) => l.name)).toContain('tamtam');
      expect(labels.map((l: { name: string }) => l.name)).toContain('review-followup');
    });

    it.concurrent('run view returns mocked log output', async () => {
      const result = await runGh(['run', 'view', '42']);
      expect(result.stdout).toContain('QA failed log line');
      expect(result.stdout).toContain('QA mocked run output');
    });
  });

  it.concurrent('returns empty JSON object for unknown subcommands', async () => {
    const result = await runGh(['unknown', 'subcommand']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('writes a qa-state.json if present in cwd for context (repo view)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-gh-mock-'));
    writeFileSync(join(dir, '.qa-state.json'), JSON.stringify({ github: 'qa/custom-repo' }, null, 2));
    try {
      // gh mock reads .qa-state.json for git mock but gh mock uses hardcoded values
      // repo view always returns qa/mock-repo (no cwd-based override)
      const result = await runGh(['repo', 'view'], dir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nameWithOwner).toBe('qa/mock-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
