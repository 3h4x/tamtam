import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '@playwright/test';

export const E2E_BASE = '/tmp/tamtam-e2e-pipeline';
export const SHIM_DIR = join(E2E_BASE, 'shim-state');
export const WORKSPACE_DIR = join(E2E_BASE, 'workspace');
export const CLAUDE_SHIM = join(__dirname, 'mocks', 'claude-shim.js');
export const CODEX_BIN = join(__dirname, 'mocks', 'codex-bin.js');

// Projects exercised by the pipeline specs.
const PROJECTS = [
  'happy-path',
  'needs-attention',
  'review-retest-live',
  'abort',
  'paused',
  'release-controls-happy-path',
  'release-controls-abort',
  'release-controls-paused',
  'release-controls-external-start',
  'ui-live',
  'runs-live',
  'strip-live',
  'history-live-done',
  'history-live-abort',
  'review-failure-history',
  'codex-shim',
  'review-cap-exhaustion',
  'fix-loop-cap-do-not-ship',
  'review-failure',
  'runs-failure-dns',
  'runs-abort-cancel',
  'strip-full-live',
  'strip-abort-commit',
  'external-start-runs',
  'external-start-failure',
  'start-detect-runs',
  'start-detect-runs-cancelled',
  'start-detect-runs-failure-idle',
  'start-detect-terminal',
  'start-detect-terminal-cancelled',
  'start-detect-terminal-failure-idle',
  'start-detect-run-idle',
  'start-detect-agent-idle',
  'queued-release-history',
  'queued-release-terminal',
  'strip-test-fail-live',
  'push-failure-live',
  'commit-failure-live',
  'commit-failure-trace',
  'commit-failure-runs',
  'commit-failure-history',
  'commit-failure-runs-expand',
  'push-failure-runs-expand',
  'review-failure-runs-expand',
  'workflow-run-detail-failure',
  'workflow-run-detail-abort',
  'workflow-run-detail-success',
  'workflow-runs-live-start-real',
  'workflow-runs-real-success',
  'workflow-runs-real-failure',
  'workflow-runs-real-cancelled',
  'workflow-runs-real-dns',
  'workflow-runs-real-abort',
  'runs-same-project-real',
  'agent-prereq-terminal',
  'issue-cruncher-prereq',
  'pr-workflow-auto-merge',
  'pr-workflow-reuse-existing-pr',
  'issue-release-auto-branch',
  'issue-release-zombie-branch-recovery',
];

export default async function globalSetup(): Promise<void> {
  // Clean up any previous run and start fresh.
  rmSync(E2E_BASE, { recursive: true, force: true });

  // Create workspace and shim-state dirs for each test project.
  for (const project of PROJECTS) {
    mkdirSync(join(WORKSPACE_DIR, project, '.git'), { recursive: true });
    // Minimal git HEAD so the workspace scanner treats this as a real repo.
    writeFileSync(join(WORKSPACE_DIR, project, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    // Write a fake source file so "git status --porcelain" has something to report.
    mkdirSync(join(WORKSPACE_DIR, project, 'src'), { recursive: true });
    writeFileSync(join(WORKSPACE_DIR, project, 'src', 'index.js'), 'const x = 1;\nmodule.exports = x;\n');

    // Initial shim state for each project.
    mkdirSync(join(SHIM_DIR, project), { recursive: true });
    writeFileSync(
      join(SHIM_DIR, project, 'git-state.json'),
      JSON.stringify({ committed: false, pushed: false }),
    );
    writeFileSync(join(SHIM_DIR, project, 'git-branch'), 'master');
    writeFileSync(join(SHIM_DIR, project, 'git-merged-branches.json'), JSON.stringify([]));
    writeFileSync(join(SHIM_DIR, project, 'git-calls.jsonl'), '');
    writeFileSync(join(SHIM_DIR, project, 'counter'), '0');
    writeFileSync(join(SHIM_DIR, project, 'git-failures.json'), JSON.stringify({}));
    writeFileSync(join(SHIM_DIR, project, 'gh-open-pr.json'), JSON.stringify(null));
    writeFileSync(join(SHIM_DIR, project, 'gh-pr-statuses.json'), JSON.stringify([]));
    writeFileSync(join(SHIM_DIR, project, 'gh-pr-status-index'), '0');
  }

  // Make shim binaries executable (they may have lost the bit after clone).
  const binDir = join(__dirname, 'mocks', 'bin');
  for (const bin of ['git', 'gh']) {
    try {
      chmodSync(join(binDir, bin), 0o755);
    } catch { /* already executable */ }
  }
  try {
    chmodSync(CLAUDE_SHIM, 0o755);
  } catch { /* already executable */ }
  try {
    chmodSync(CODEX_BIN, 0o755);
  } catch { /* already executable */ }

  // Configure the test server: point workspace_path at our temp workspace,
  // set claude_bin to the shim, set log_dir inside the temp tree.
  const context = await request.newContext({ baseURL: 'http://localhost:1338' });
  try {
    await context.patch('/api/settings', {
      data: {
        workspace_path: WORKSPACE_DIR,
        claude_bin: CLAUDE_SHIM,
        log_dir: join(E2E_BASE, 'data', 'logs'),
      },
    });

    // Trigger workspace scan so the projects appear in the DB.
    await context.get('/api/config/projects');
  } finally {
    await context.dispose();
  }
}
