import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function runSeed(env: {
  dbPath: string;
  workspace: string;
  logDir: string;
}) {
  return execFileSync(
    process.execPath,
    ['scripts/qa-seed.mjs'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TAMTAM_DB_PATH: env.dbPath,
        TAMTAM_QA_WORKSPACE: env.workspace,
        TAMTAM_QA_LOG_DIR: env.logDir,
      },
      encoding: 'utf-8',
    },
  );
}

describe('scripts/qa-seed.mjs', () => {
  it('seeds the QA workspace and sqlite database at the provided paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-qa-seed-'));

    try {
      const dbPath = join(dir, 'db', 'tamtam-qa.db');
      const workspace = join(dir, 'workspace');
      const logDir = join(dir, 'logs');

      const stdout = runSeed({ dbPath, workspace, logDir });

      expect(stdout).toContain(`[qa-seed] seeded 3 projects at ${workspace}`);
      expect(existsSync(logDir)).toBe(true);

      const apiRoot = join(workspace, 'api-service');
      const webRoot = join(workspace, 'web-console');
      const workerRoot = join(workspace, 'worker-kit');
      expect(readFileSync(join(apiRoot, 'README.md'), 'utf-8')).toContain('# api-service');
      expect(readFileSync(join(webRoot, '.tamtam', 'config.yml'), 'utf-8')).toContain('test_command: pnpm test:e2e');
      expect(readFileSync(join(workerRoot, '.tamtam', 'agents', 'release-check.md'), 'utf-8')).toContain('provider: claude');
      expect(JSON.parse(readFileSync(join(apiRoot, '.qa-state.json'), 'utf-8'))).toMatchObject({
        name: 'api-service',
        priority: 'critical',
      });

      const db = new Database(dbPath, { readonly: true });
      const settings = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
      const settingsMap = new Map(settings.map(({ key, value }) => [key, value]));
      expect(settingsMap.get('workspace_path')).toBe(workspace);
      expect(settingsMap.get('log_dir')).toBe(logDir);
      expect(settingsMap.get('cli_bin_claude')).toBe('/app/scripts/qa-shim.js');

      const projects = db.prepare('SELECT name, github, priority, test_command AS testCommand FROM projects ORDER BY name').all() as Array<{
        name: string;
        github: string;
        priority: string;
        testCommand: string;
      }>;
      expect(projects).toEqual([
        { name: 'api-service', github: 'qa/api-service', priority: 'critical', testCommand: 'pnpm test' },
        { name: 'web-console', github: 'qa/web-console', priority: 'high', testCommand: 'pnpm test:e2e' },
        { name: 'worker-kit', github: 'qa/worker-kit', priority: 'medium', testCommand: 'pnpm test' },
      ]);

      const agentCount = db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number };
      const skillCount = db.prepare('SELECT COUNT(*) AS count FROM skills').get() as { count: number };
      const recommendationCount = db.prepare('SELECT COUNT(*) AS count FROM recommendations').get() as { count: number };
      const jobCount = db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
      expect(agentCount.count).toBe(3);
      expect(skillCount.count).toBe(3);
      expect(recommendationCount.count).toBe(3);
      expect(jobCount.count).toBe(3);

      const statusRows = db.prepare('SELECT project, ci FROM gh_status ORDER BY project').all() as Array<{ project: string; ci: string }>;
      expect(statusRows).toEqual([
        { project: 'api-service', ci: 'passing' },
        { project: 'web-console', ci: 'failing' },
        { project: 'worker-kit', ci: 'passing' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recreates the workspace on rerun instead of preserving stale files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-qa-seed-rerun-'));

    try {
      const dbPath = join(dir, 'db', 'tamtam-qa.db');
      const workspace = join(dir, 'workspace');
      const logDir = join(dir, 'logs');

      runSeed({ dbPath, workspace, logDir });

      const staleFile = join(workspace, 'api-service', 'stale.txt');
      writeFileSync(staleFile, 'remove me');
      expect(existsSync(staleFile)).toBe(true);

      runSeed({ dbPath, workspace, logDir });

      expect(existsSync(staleFile)).toBe(false);

      const db = new Database(dbPath, { readonly: true });
      const recommendationIds = db.prepare('SELECT id FROM recommendations ORDER BY id').all() as Array<{ id: string }>;
      expect(recommendationIds).toEqual([
        { id: 'qa-api-service-recommendation' },
        { id: 'qa-web-console-recommendation' },
        { id: 'qa-worker-kit-recommendation' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
