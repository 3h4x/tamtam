import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const repoRoot = process.cwd();

function makeLog(text: string) {
  return [
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      session_id: 's1',
      result: '',
    }),
  ].join('\n');
}

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      pid integer NOT NULL,
      started_at double precision NOT NULL,
      log_path text,
      finished_at double precision,
      gh_issue_number integer,
      work_summary text
    )
  `));
}

describe('issue-run summary scripts', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    // Let any straggling fire-and-forget queries settle before closing.
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE jobs'));
    // Mock `pg` so the .mjs scripts hit the in-process PGlite handle. The
    // scripts only need `Pool` with `query(sql, params)` and `end()`.
    const raw = sharedHandle.raw;
    class FakePool {
      async query(text: string, params?: unknown[]) {
        return raw.query(text, (params ?? []) as unknown[]);
      }
      async end() {
        // PGlite handle is shared across tests; no-op here.
      }
    }
    vi.doMock('pg', () => ({
      default: { Pool: FakePool },
      Pool: FakePool,
    }));
    // Ensure DATABASE_URL is set so resolveDatabaseUrl() does not throw.
    process.env.DATABASE_URL = 'postgres://fake@localhost/fake';
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('exposes explicit package.json entrypoints for the maintenance scripts', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['backfill:issue-run-summaries']).toBe('node scripts/backfill-issue-run-summaries.mjs');
    expect(pkg.scripts['backfill:issue-cruncher-numbers']).toBe('node scripts/backfill-issue-cruncher-numbers.mjs');
    expect(pkg.scripts['check:summary-extraction']).toBe('node scripts/check-summary-extraction.mjs');
    expect(pkg.scripts['peek:summary']).toBe('node scripts/peek-summary.mjs');
  });

  it('runs the issue-cruncher number backfill against the in-process database', async () => {
    await sharedHandle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary)
      VALUES
        ('cruncher-1', 'proj', 'agent:issue-cruncher', 1003, 1, NULL, 2, NULL, 'Worked issue #70, wired the endpoint, and added guardrails.'),
        ('cruncher-2', 'proj', 'agent:issue-cruncher', 1004, 1, NULL, 2, NULL, 'Refreshed docs only.')
    `));

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      await import('../../scripts/backfill-issue-cruncher-numbers.mjs');
    } finally {
      console.log = origLog;
    }
    const stdout = captured.join('\n');
    expect(stdout).toContain('Found 2 issue-cruncher rows to backfill');
    expect(stdout).toContain('[cruncher-1] -> #70');
    expect(stdout).toContain('Done. updated=1 skipped=1');

    const result = await sharedHandle.raw.query<{ id: string; gh_issue_number: number | null }>(
      'SELECT id, gh_issue_number FROM jobs ORDER BY id',
    );
    const byId = new Map(result.rows.map((r) => [r.id, r.gh_issue_number]));
    expect(byId.get('cruncher-1')).toBe(70);
    expect(byId.get('cruncher-2')).toBeNull();
  });

  it('runs the backfill and inspection scripts against the in-process database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-summary-scripts-'));
    try {
      const logPath = join(dir, 'issue-run.ndjson');
      writeFileSync(
        logPath,
        makeLog('Reviewing the failing specs first.\n\nChecking the fixture setup now.\n\nFixed the off-by-one in foo.ts and added a regression test.'),
      );

      await sharedHandle.db.execute(sql.raw(`
        INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary)
        VALUES
          ('issue-1', 'proj', 'run', 1001, 1, '${logPath}', 2, 42, NULL),
          ('issue-2', 'proj', 'run', 1002, 1, '${join(dir, 'missing.ndjson')}', 2, 43, NULL)
      `));

      const backfillCaptured: string[] = [];
      const origLog1 = console.log;
      console.log = (...args: unknown[]) => {
        backfillCaptured.push(args.map(String).join(' '));
      };
      try {
        await import('../../scripts/backfill-issue-run-summaries.mjs');
      } finally {
        console.log = origLog1;
      }
      const backfillStdout = backfillCaptured.join('\n');
      expect(backfillStdout).toContain('Found 2 issue-run summaries to backfill');
      expect(backfillStdout).toContain('updated=1 missingLog=1 noSummary=0');
      expect(backfillStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');

      vi.resetModules();
      const checkCaptured: string[] = [];
      const origLog2 = console.log;
      console.log = (...args: unknown[]) => {
        checkCaptured.push(args.map(String).join(' '));
      };
      try {
        await import('../../scripts/check-summary-extraction.mjs');
      } finally {
        console.log = origLog2;
      }
      const checkStdout = checkCaptured.join('\n');
      expect(checkStdout).toContain('=== [issue-1] run #42');
      expect(checkStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');
      expect(checkStdout).not.toContain('Reviewing the failing specs first.');

      // peek-summary.mjs reads a file path from process.argv and does not touch
      // the database, so we can keep it as a subprocess invocation.
      const peekStdout = execFileSync(
        process.execPath,
        ['scripts/peek-summary.mjs', logPath],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      expect(peekStdout).toContain('Total paragraphs: 3');
      expect(peekStdout).toContain('Reviewing the failing specs first.');
      expect(peekStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');

      const after = await sharedHandle.raw.query<{ id: string; work_summary: string | null }>(
        "SELECT id, work_summary FROM jobs WHERE id = 'issue-1'",
      );
      expect(after.rows[0]?.work_summary).toBe('Fixed the off-by-one in foo.ts and added a regression test.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
