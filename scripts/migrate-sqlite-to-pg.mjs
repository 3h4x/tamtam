#!/usr/bin/env node
/* eslint-env node */

import Database from 'better-sqlite3';
import pg from 'pg';
import { join } from 'path';
import { existsSync } from 'fs';

const { Pool } = pg;

const HELP = `Usage: node scripts/migrate-sqlite-to-pg.mjs [options]

Migrates rows from a TamTam SQLite database into the Postgres database
referenced by DATABASE_URL.

Options:
  --from <path>         Source SQLite file (default: $TAMTAM_DB_PATH or data/db/tamtam.db)
  --truncate            TRUNCATE each target table before insert
  --dry-run             Count rows that would move; perform no writes
  --only <t1,t2,...>    Migrate only the listed tables
  --help                Show this message
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const sqlitePath =
  args.from ?? process.env.TAMTAM_DB_PATH ?? join(process.cwd(), 'data', 'db', 'tamtam.db');
if (!existsSync(sqlitePath)) {
  console.error(`[migrate] source SQLite file not found: ${sqlitePath}`);
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

const TABLES = [
  { name: 'settings', cols: [['key'], ['value']] },
  {
    name: 'projects',
    cols: [
      ['name'],
      ['path'],
      ['enabled', boolCoerce],
      ['github'],
      ['priority'],
      ['custom_actions'],
      ['test_command'],
      ['tests_disabled', boolCoerce],
      ['review_disabled', boolCoerce],
      ['test_cron_enabled', boolCoerce],
      ['test_cron_schedule'],
      ['auto_commit_enabled', boolCoerce],
      ['auto_push_enabled', boolCoerce],
      ['auto_pr_merge_enabled', boolCoerce],
      ['release_after_run', boolCoerce],
      ['issue_auto_branch', boolCoerce],
      ['last_push_error'],
      ['last_push_at'],
      ['review_prompt_addendum'],
      ['fix_prompt_addendum'],
      ['website'],
      ['qa_url'],
      ['archived', boolCoerce],
      ['paused', boolCoerce],
    ],
  },
  {
    name: 'jobs',
    cols: [
      ['id'],
      ['project'],
      ['kind'],
      ['prompt'],
      ['pid'],
      ['log_path'],
      ['started_at'],
      ['finished_at'],
      ['exit_code'],
      ['seen', boolCoerce],
      ['duration_ms'],
      ['input_tokens'],
      ['output_tokens'],
      ['cache_read_tokens'],
      ['cache_create_tokens'],
      ['session_id'],
      ['user_prompt'],
      ['context_meta'],
      ['parent_job_id'],
      ['gh_issue_number'],
      ['gh_issue_repo'],
      ['gh_issue_title'],
      ['log_pruned', boolCoerce],
      ['verdict'],
      ['cost_usd'],
      ['model'],
      ['release_id'],
      ['aborted_at'],
      ['prompt_bytes'],
      ['work_summary'],
      ['modified_files'],
      ['provider'],
    ],
  },
  {
    name: 'skills',
    cols: [['id'], ['name'], ['description'], ['content'], ['created_at'], ['updated_at']],
  },
  {
    name: 'agents',
    cols: [
      ['id'],
      ['name'],
      ['project'],
      ['skill_ids'],
      ['model'],
      ['prompt'],
      ['schedule'],
      ['runner'],
      ['enabled', boolCoerce],
      ['doc_paths'],
      ['provider'],
      ['prerequisite_command'],
      ['created_at'],
      ['updated_at'],
    ],
  },
  {
    name: 'recommendations',
    cols: [
      ['id'],
      ['project'],
      ['source_kind'],
      ['source_id'],
      ['agent_id'],
      ['agent_name'],
      ['type'],
      ['title'],
      ['detail'],
      ['status'],
      ['payload'],
      ['created_at'],
      ['updated_at'],
    ],
  },
  {
    name: 'gh_status',
    cols: [
      ['project'],
      ['release_tag'],
      ['ci'],
      ['ci_failed_url'],
      ['head_sha'],
      ['local_head_sha'],
      ['fetched_at'],
    ],
  },
  {
    name: 'gh_issues_cache',
    cols: [['project'], ['repo'], ['prs'], ['issues'], ['fetched_at']],
  },
  {
    name: 'pipeline_locks',
    cols: [['project'], ['locked_by_job_id'], ['acquired_at']],
  },
  {
    name: 'queued_agent_runs',
    cols: [
      ['id'],
      ['project'],
      ['agent_id'],
      ['agent_name'],
      ['triggered_by'],
      ['prompt'],
      ['enqueued_at'],
    ],
  },
  {
    name: 'notification_throttle',
    cols: [['key'], ['last_sent_at'], ['suppressed_count']],
  },
  {
    name: 'maintenance_status',
    cols: [['key'], ['value'], ['updated_at']],
  },
];

const onlyFilter = args.only ? new Set(args.only.split(',')) : null;
const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({ connectionString: dbUrl });

let total = 0;
try {
  for (const table of TABLES) {
    if (onlyFilter && !onlyFilter.has(table.name)) continue;
    if (!hasTable(sqlite, table.name)) {
      console.log(`[migrate] skip ${table.name}: not present in source`);
      continue;
    }
    const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
    if (rows.length === 0) {
      console.log(`[migrate] ${table.name}: 0 rows`);
      continue;
    }
    if (args.dryRun) {
      console.log(`[migrate] ${table.name}: would move ${rows.length} rows (dry-run)`);
      total += rows.length;
      continue;
    }
    if (args.truncate) {
      await pool.query(`TRUNCATE TABLE ${table.name} RESTART IDENTITY CASCADE`);
    }

    const pkCol = pkOf(table.name);
    const colNames = table.cols.map(([c]) => c);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
    const onConflict = args.truncate ? '' : `ON CONFLICT (${pkCol}) DO NOTHING`;
    const insertSql = `INSERT INTO ${table.name} (${colNames.join(', ')}) VALUES (${placeholders}) ${onConflict}`;

    let inserted = 0;
    for (const row of rows) {
      const values = table.cols.map(([col, coerce]) => {
        const v = row[col];
        return coerce ? coerce(v) : v;
      });
      const res = await pool.query(insertSql, values);
      inserted += res.rowCount ?? 0;
    }
    console.log(`[migrate] ${table.name}: ${inserted}/${rows.length} rows inserted`);
    total += inserted;
  }
  console.log(`[migrate] done — ${total} rows moved${args.dryRun ? ' (dry-run)' : ''}`);
} catch (err) {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}

function boolCoerce(v) {
  if (v == null) return null;
  return v === 1 || v === '1' || v === true;
}

function hasTable(sqlite, name) {
  const row = sqlite
    .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', name);
  return Boolean(row);
}

function pkOf(table) {
  const explicit = {
    queued_agent_runs: 'id',
    notification_throttle: 'key',
    maintenance_status: 'key',
    gh_status: 'project',
    gh_issues_cache: 'project',
    pipeline_locks: 'project',
    projects: 'name',
    settings: 'key',
  };
  return explicit[table] ?? 'id';
}

function parseArgs(argv) {
  const out = { dryRun: false, truncate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--truncate') out.truncate = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only') out.only = argv[++i];
  }
  return out;
}
