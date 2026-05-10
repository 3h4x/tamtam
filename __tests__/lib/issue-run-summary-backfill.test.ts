import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
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
  return sqlite;
}

describe('issue-run-summary-backfill', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let listIssueRunSummaryBackfillCandidates: typeof import('@/lib/agents/issue-run-summary-backfill').listIssueRunSummaryBackfillCandidates;

  beforeEach(async () => {
    testDb = createTestDb();
    vi.resetModules();
    vi.doMock('@/lib/db', () => {
      const { drizzle } = require('drizzle-orm/better-sqlite3');
      const { sqliteTable, text, integer, real } = require('drizzle-orm/sqlite-core');
      const jobs = sqliteTable('jobs', {
        id: text('id').primaryKey(),
        project: text('project').notNull(),
        kind: text('kind').notNull(),
        pid: integer('pid').notNull(),
        startedAt: real('started_at').notNull(),
        logPath: text('log_path'),
        finishedAt: real('finished_at'),
        ghIssueNumber: integer('gh_issue_number'),
        workSummary: text('work_summary'),
      });
      return {
        db: drizzle(testDb),
        schema: { jobs },
      };
    });
    ({ listIssueRunSummaryBackfillCandidates } = await import('@/lib/agents/issue-run-summary-backfill'));
  });

  it('returns only finished issue-linked runs whose summary is still missing', () => {
    testDb.exec(`
      INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary) VALUES
        ('issue-null', 'proj', 'run', 1001, 1, '/logs/issue-null.ndjson', 2, 42, NULL),
        ('issue-empty', 'proj', 'run', 1002, 1, '/logs/issue-empty.ndjson', 2, 43, ''),
        ('issue-filled', 'proj', 'run', 1003, 1, '/logs/issue-filled.ndjson', 2, 44, 'Already summarized'),
        ('issue-no-log', 'proj', 'run', 1004, 1, NULL, 2, 45, NULL),
        ('issue-running', 'proj', 'run', 1005, 1, '/logs/issue-running.ndjson', NULL, 46, NULL),
        ('non-issue-run', 'proj', 'run', 1006, 1, '/logs/non-issue.ndjson', 2, NULL, NULL),
        ('agent-run', 'proj', 'agent:tests', 1007, 1, '/logs/agent.ndjson', 2, 47, NULL)
    `);

    expect(listIssueRunSummaryBackfillCandidates()).toEqual([
      { id: 'issue-null', logPath: '/logs/issue-null.ndjson' },
      { id: 'issue-empty', logPath: '/logs/issue-empty.ndjson' },
    ]);
  });

  it('does not treat agent rows or ordinary terminal runs as backfill targets', () => {
    testDb.exec(`
      INSERT INTO jobs (id, project, kind, pid, started_at, log_path, finished_at, gh_issue_number, work_summary) VALUES
        ('agent-null', 'proj', 'agent:docs', 1001, 1, '/logs/agent-null.ndjson', 2, NULL, NULL),
        ('run-non-issue', 'proj', 'run', 1002, 1, '/logs/run-non-issue.ndjson', 2, NULL, NULL),
        ('issue-filled', 'proj', 'run', 1003, 1, '/logs/issue-filled.ndjson', 2, 9, 'done')
    `);

    expect(listIssueRunSummaryBackfillCandidates()).toEqual([]);
  });
});
