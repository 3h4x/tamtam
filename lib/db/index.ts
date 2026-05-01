import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';

const dbPath = process.env.TAMTAM_DB_PATH ?? join(process.cwd(), 'data', 'db', 'tamtam.db');
const dbDir = dirname(dbPath);
mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Ensure tables exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT,
    pid INTEGER NOT NULL,
    log_path TEXT,
    started_at REAL NOT NULL,
    finished_at REAL,
    exit_code INTEGER,
    seen INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS gh_status (
    project TEXT PRIMARY KEY,
    release_tag TEXT,
    ci TEXT,
    ci_failed_url TEXT,
    head_sha TEXT,
    local_head_sha TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    github TEXT,
    priority TEXT,
    custom_actions TEXT
  );
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project TEXT NOT NULL,
    skill_ids TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT 'sonnet',
    prompt TEXT NOT NULL DEFAULT '',
    schedule TEXT,
    runner TEXT NOT NULL DEFAULT 'pm2',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
`);

// Migrate: add custom_actions column if missing
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN custom_actions TEXT');
} catch {
  // column already exists
}

// Migrate: add prompt column to jobs if missing
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN prompt TEXT');
} catch {}

// Migrate: add schedule, runner, prompt columns to agents if missing
try {
  sqlite.exec('ALTER TABLE agents ADD COLUMN schedule TEXT');
} catch {}
try {
  sqlite.exec("ALTER TABLE agents ADD COLUMN runner TEXT NOT NULL DEFAULT 'pm2'");
} catch {}
try {
  sqlite.exec("ALTER TABLE agents ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
} catch {}

// Migrate: add user_prompt and context_meta columns to jobs if missing
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN user_prompt TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN context_meta TEXT');
} catch {}

// Migrate: add test_command and cron columns to projects if missing
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN test_command TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN test_cron_enabled INTEGER DEFAULT 0');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN test_cron_schedule TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN auto_push_enabled INTEGER DEFAULT 0');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN parent_job_id TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN last_push_error TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN last_push_at REAL');
} catch {}

// Migrate: add enabled column to agents if missing
try {
  sqlite.exec('ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
} catch {}

// gh_issues_cache table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS gh_issues_cache (
    project TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    prs TEXT NOT NULL DEFAULT '[]',
    issues TEXT NOT NULL DEFAULT '[]',
    fetched_at REAL NOT NULL
  );
`);

// pipeline_locks table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_locks (
    project TEXT PRIMARY KEY,
    locked_by_job_id TEXT NOT NULL,
    acquired_at REAL NOT NULL
  );
`);

// Migrate: add token/duration/session columns to jobs if missing
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN duration_ms INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN input_tokens INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN output_tokens INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN cache_read_tokens INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN cache_create_tokens INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN session_id TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN auto_commit_enabled INTEGER DEFAULT 0');
} catch {}
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN release_after_run INTEGER DEFAULT 0');
} catch {}

// Migrate: add GitHub issue linking columns to jobs
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN gh_issue_number INTEGER');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN gh_issue_repo TEXT');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN gh_issue_title TEXT');
} catch {}

// Migrate: add log_pruned flag for retention
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN log_pruned INTEGER DEFAULT 0');
} catch {}

// Migrate: add auto_pr_merge_enabled column to projects if missing
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN auto_pr_merge_enabled INTEGER DEFAULT 0');
} catch {}

// Migrate: add pr_workflow_enabled column to projects if missing
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN pr_workflow_enabled INTEGER DEFAULT 0');
} catch {}

// Migrate: add issue_auto_branch to projects — controls the "Work on" feature-branch step.
// Default 1 (existing behavior: always provision fix/issue-<n>-<slug>).
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN issue_auto_branch INTEGER DEFAULT 1');
} catch {}

// Migrate: add tests_disabled to projects — explicit off-switch for the test step
// in the release pipeline. When true, the test step is skipped even if a test
// command would otherwise be auto-detected.
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN tests_disabled INTEGER DEFAULT 0');
} catch {}

// Migrate: add review_disabled to projects — off-switch for the AI review step,
// e.g. when the agent prompt itself already performs review.
try {
  sqlite.exec('ALTER TABLE projects ADD COLUMN review_disabled INTEGER DEFAULT 0');
} catch {}

// Migrate: add cost_usd and model columns to jobs
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN cost_usd REAL');
} catch {}
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN model TEXT');
} catch {}

// Migrate: add release_id to jobs — links pipeline step jobs to their parent release
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN release_id TEXT');
} catch {}

// Migrate: add aborted_at to jobs — set when a release pipeline is aborted mid-run
try {
  sqlite.exec('ALTER TABLE jobs ADD COLUMN aborted_at REAL');
} catch {}

export const db = drizzle(sqlite, { schema });
export { schema };
