import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';

// qa-seed.mjs is a top-level script that creates `new pg.Pool({ connectionString })`
// against $DATABASE_URL. PGlite is in-process only — it cannot serve a subprocess.
// We invoke the script via dynamic ESM import in-process, with `pg` mocked so the
// Pool delegates to the shared PGlite instance.

let sharedHandle: TestDbHandle;

function makePgMock(handle: TestDbHandle) {
  class Pool {
    constructor(_opts: unknown) {}
    async query(text: string, params?: unknown[]) {
      return handle.raw.query(text, (params ?? []) as unknown[]);
    }
    async end() {
      /* no-op: handle disposed by afterAll */
    }
  }
  return { default: { Pool }, Pool };
}

async function truncateAll() {
  // Order doesn't matter for TRUNCATE ... CASCADE; we list all tables qa-seed
  // touches plus a couple it indirectly relies on for cleanliness.
  await sharedHandle.db.execute(sql.raw(
    'TRUNCATE settings, projects, jobs, skills, agents, gh_status, gh_issues_cache, recommendations RESTART IDENTITY CASCADE',
  ));
}

async function runSeed(env: { workspace: string; logDir: string }) {
  process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
  process.env.TAMTAM_QA_WORKSPACE = env.workspace;
  process.env.TAMTAM_QA_LOG_DIR = env.logDir;

  vi.resetModules();
  vi.doMock('pg', () => makePgMock(sharedHandle));

  // Capture stdout written by the script via console.log.
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    // vi.resetModules() above clears the import cache so the script's
    // top-level side effects run each invocation.
    await import('@/scripts/qa-seed.mjs');
  } finally {
    console.log = origLog;
  }

  return lines.join('\n') + '\n';
}

describe('scripts/qa-seed.mjs', () => {
  beforeAll(async () => {
    sharedHandle = await createTestPgDb();
  }, 30000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.TAMTAM_QA_WORKSPACE;
    delete process.env.TAMTAM_QA_LOG_DIR;
  });

  it('seeds the QA workspace and database at the provided paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-qa-seed-'));

    try {
      const workspace = join(dir, 'workspace');
      const logDir = join(dir, 'logs');

      const stdout = await runSeed({ workspace, logDir });

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

      const settingsRows = await sharedHandle.raw.query<{ key: string; value: string }>(
        'SELECT key, value FROM settings',
      );
      const settingsMap = new Map(settingsRows.rows.map(({ key, value }) => [key, value]));
      expect(settingsMap.get('workspace_path')).toBe(workspace);
      expect(settingsMap.get('log_dir')).toBe(logDir);
      expect(settingsMap.get('cli_bin_claude')).toBe('/app/scripts/qa-shim.js');

      const projectRows = await sharedHandle.raw.query<{
        name: string;
        github: string;
        priority: string;
        testCommand: string;
      }>(
        'SELECT name, github, priority, test_command AS "testCommand" FROM projects ORDER BY name',
      );
      expect(projectRows.rows).toEqual([
        { name: 'api-service', github: 'qa/api-service', priority: 'critical', testCommand: 'pnpm test' },
        { name: 'web-console', github: 'qa/web-console', priority: 'high', testCommand: 'pnpm test:e2e' },
        { name: 'worker-kit', github: 'qa/worker-kit', priority: 'medium', testCommand: 'pnpm test' },
      ]);

      const agentCount = await sharedHandle.raw.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM agents');
      const skillCount = await sharedHandle.raw.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM skills');
      const recommendationCount = await sharedHandle.raw.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM recommendations',
      );
      const jobCount = await sharedHandle.raw.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM jobs');
      expect(Number(agentCount.rows[0].count)).toBe(3);
      expect(Number(skillCount.rows[0].count)).toBe(3);
      expect(Number(recommendationCount.rows[0].count)).toBe(3);
      expect(Number(jobCount.rows[0].count)).toBe(3);

      const statusRows = await sharedHandle.raw.query<{ project: string; ci: string }>(
        'SELECT project, ci FROM gh_status ORDER BY project',
      );
      expect(statusRows.rows).toEqual([
        { project: 'api-service', ci: 'passing' },
        { project: 'web-console', ci: 'failing' },
        { project: 'worker-kit', ci: 'passing' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recreates the workspace on rerun instead of preserving stale files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-qa-seed-rerun-'));

    try {
      const workspace = join(dir, 'workspace');
      const logDir = join(dir, 'logs');

      await runSeed({ workspace, logDir });

      const staleFile = join(workspace, 'api-service', 'stale.txt');
      writeFileSync(staleFile, 'remove me');
      expect(existsSync(staleFile)).toBe(true);

      await runSeed({ workspace, logDir });

      expect(existsSync(staleFile)).toBe(false);

      const recommendationIds = await sharedHandle.raw.query<{ id: string }>(
        'SELECT id FROM recommendations ORDER BY id',
      );
      expect(recommendationIds.rows).toEqual([
        { id: 'qa-api-service-recommendation' },
        { id: 'qa-web-console-recommendation' },
        { id: 'qa-worker-kit-recommendation' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
