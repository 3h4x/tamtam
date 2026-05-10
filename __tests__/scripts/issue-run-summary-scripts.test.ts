import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

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

function createJobsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at REAL NOT NULL,
      log_path TEXT,
      finished_at REAL,
      gh_issue_number INTEGER,
      work_summary TEXT
    )
  `);
}

describe('issue-run summary scripts', () => {
  it('exposes explicit package.json entrypoints for the maintenance scripts', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['backfill:issue-run-summaries']).toBe('node scripts/backfill-issue-run-summaries.mjs');
    expect(pkg.scripts['check:summary-extraction']).toBe('node scripts/check-summary-extraction.mjs');
    expect(pkg.scripts['peek:summary']).toBe('node scripts/peek-summary.mjs');
  });

  it('runs the backfill and inspection scripts against a temp sqlite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-summary-scripts-'));
    try {
      const dbPath = join(dir, 'tamtam.db');
      const logPath = join(dir, 'issue-run.ndjson');
      writeFileSync(
        logPath,
        makeLog('Reviewing the failing specs first.\n\nChecking the fixture setup now.\n\nFixed the off-by-one in foo.ts and added a regression test.'),
      );

      const db = new Database(dbPath);
      createJobsTable(db);
      db.prepare(`
        INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('issue-1', 'proj', 'run', 1001, 1, logPath, 2, 42, null);
      db.prepare(`
        INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('issue-2', 'proj', 'run', 1002, 1, join(dir, 'missing.ndjson'), 2, 43, null);
      db.close();

      const env = { ...process.env, TAMTAM_DB_PATH: dbPath };
      const backfillStdout = execFileSync(
        process.execPath,
        ['scripts/backfill-issue-run-summaries.mjs'],
        { cwd: repoRoot, env, encoding: 'utf-8' },
      );
      expect(backfillStdout).toContain('Found 2 issue-run summaries to backfill');
      expect(backfillStdout).toContain('updated=1 missingLog=1 noSummary=0');
      expect(backfillStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');

      const checkStdout = execFileSync(
        process.execPath,
        ['scripts/check-summary-extraction.mjs'],
        { cwd: repoRoot, env, encoding: 'utf-8' },
      );
      expect(checkStdout).toContain('=== [issue-1] run #42');
      expect(checkStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');
      expect(checkStdout).not.toContain('Reviewing the failing specs first.');

      const peekStdout = execFileSync(
        process.execPath,
        ['scripts/peek-summary.mjs', logPath],
        { cwd: repoRoot, env, encoding: 'utf-8' },
      );
      expect(peekStdout).toContain('Total paragraphs: 3');
      expect(peekStdout).toContain('Reviewing the failing specs first.');
      expect(peekStdout).toContain('Fixed the off-by-one in foo.ts and added a regression test.');

      const checkDb = new Database(dbPath, { readonly: true });
      const updated = checkDb.prepare('SELECT work_summary AS workSummary FROM jobs WHERE id = ?').get('issue-1') as
        | { workSummary: string | null }
        | undefined;
      expect(updated?.workSummary).toBe('Fixed the off-by-one in foo.ts and added a regression test.');
      checkDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
