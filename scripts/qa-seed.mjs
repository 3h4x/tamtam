#!/usr/bin/env node

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';

const dbPath = process.env.TAMTAM_DB_PATH || '/qa/data/tamtam-qa.db';
const workspace = process.env.TAMTAM_QA_WORKSPACE || '/qa/workspace';
const logDir = process.env.TAMTAM_QA_LOG_DIR || '/qa/logs';
const now = Date.now() / 1000;

mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(logDir, { recursive: true });

const projects = [
  {
    name: 'api-service',
    priority: 'critical',
    branch: 'main',
    github: 'qa/api-service',
    changes: ' M src/server.ts\n M package.json\n?? docs/api-notes.md\n',
    testCommand: 'pnpm test',
  },
  {
    name: 'web-console',
    priority: 'high',
    branch: 'feature/qa-dashboard',
    github: 'qa/web-console',
    changes: ' M components/Dashboard.tsx\n?? e2e/dashboard.spec.ts\n',
    testCommand: 'pnpm test:e2e',
  },
  {
    name: 'worker-kit',
    priority: 'medium',
    branch: 'main',
    github: 'qa/worker-kit',
    changes: '',
    testCommand: 'pnpm test',
  },
];

rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

for (const project of projects) {
  const root = join(workspace, project.name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.tamtam', 'agents'), { recursive: true });
  writeFileSync(join(root, 'README.md'), `# ${project.name}\n\nSeeded QA project for TamTam.\n`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo qa test pass' } }, null, 2));
  writeFileSync(join(root, 'src', 'index.ts'), `export const projectName = '${project.name}';\n`);
  writeFileSync(join(root, '.tamtam', 'config.yml'), `pipeline:\n  test_command: ${project.testCommand}\n`);
  writeFileSync(join(root, '.tamtam', 'agents', 'release-check.md'), `---\nprovider: claude\nmodel: fast\nschedule: 1h\nskillIds: [\"qa-release\"]\nrunner: pm2\nenabled: true\n---\nRun a deterministic QA release readiness check for ${project.name}.\n`);
  writeFileSync(join(root, '.qa-state.json'), JSON.stringify(project, null, 2));
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    github TEXT,
    priority TEXT,
    custom_actions TEXT,
    website TEXT,
    test_command TEXT,
    test_cron_enabled INTEGER DEFAULT 0,
    test_cron_schedule TEXT,
    auto_push_enabled INTEGER DEFAULT 0,
    auto_commit_enabled INTEGER DEFAULT 0,
    release_after_run INTEGER DEFAULT 0,
    auto_pr_merge_enabled INTEGER DEFAULT 0,
    issue_auto_branch INTEGER DEFAULT 1,
    tests_disabled INTEGER DEFAULT 0,
    review_disabled INTEGER DEFAULT 0,
    last_push_error TEXT,
    last_push_at REAL,
    review_prompt_addendum TEXT,
    fix_prompt_addendum TEXT
  );
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
    seen INTEGER DEFAULT 0,
    duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_create_tokens INTEGER,
    session_id TEXT,
    user_prompt TEXT,
    context_meta TEXT,
    parent_job_id TEXT,
    gh_issue_number INTEGER,
    gh_issue_repo TEXT,
    gh_issue_title TEXT,
    log_pruned INTEGER DEFAULT 0,
    verdict TEXT,
    cost_usd REAL,
    model TEXT,
    release_id TEXT,
    aborted_at REAL,
    prompt_bytes INTEGER,
    work_summary TEXT,
    modified_files TEXT,
    provider TEXT
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
    model TEXT NOT NULL DEFAULT 'normal',
    prompt TEXT NOT NULL DEFAULT '',
    schedule TEXT,
    runner TEXT NOT NULL DEFAULT 'pm2',
    enabled INTEGER NOT NULL DEFAULT 1,
    doc_paths TEXT NOT NULL DEFAULT '[]',
    provider TEXT,
    prerequisite_command TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
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
  CREATE TABLE IF NOT EXISTS gh_issues_cache (
    project TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    prs TEXT NOT NULL DEFAULT '[]',
    issues TEXT NOT NULL DEFAULT '[]',
    fetched_at REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pipeline_locks (
    project TEXT PRIMARY KEY,
    locked_by_job_id TEXT NOT NULL,
    acquired_at REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS queued_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    prompt TEXT NOT NULL DEFAULT '',
    enqueued_at REAL NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS queued_agent_runs_project_agent ON queued_agent_runs (project, agent_id);
  CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT,
    agent_id TEXT,
    agent_name TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    payload TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
`);

const upsertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
for (const [key, value] of Object.entries({
  workspace_path: workspace,
  log_dir: logDir,
  frequency: '30m',
  daytime: 'true',
  weekends: 'on',
  claude_provider: 'claude',
  cli_enabled_providers: 'claude',
  cli_bin_claude: '/app/scripts/qa-shim.js',
  cli_default_model_claude: 'fast',
  default_model: 'fast',
  permission_mode: 'bypassPermissions',
  jobs_paused: 'false',
  budget_block_runs_enabled: 'false',
  github_owner: 'qa',
  review_verdict_rules: 'QA accepts deterministic LGTM from qa-shim for seeded projects.',
  commit_style: 'Conventional commits, imperative mood, under 72 chars.',
})) upsertSetting.run(key, value);

const upsertProject = db.prepare(`
  INSERT INTO projects (
    name, path, enabled, github, priority, custom_actions, test_command,
    test_cron_enabled, test_cron_schedule, auto_commit_enabled, auto_push_enabled,
    auto_pr_merge_enabled, release_after_run, issue_auto_branch
  ) VALUES (?, ?, 1, ?, ?, ?, ?, 1, '30m', 1, 1, 0, 0, 1)
  ON CONFLICT(name) DO UPDATE SET
    path = excluded.path,
    enabled = 1,
    github = excluded.github,
    priority = excluded.priority,
    custom_actions = excluded.custom_actions,
    test_command = excluded.test_command,
    test_cron_enabled = 1,
    test_cron_schedule = '30m',
    auto_commit_enabled = 1,
    auto_push_enabled = 1
`);
for (const project of projects) {
  const actions = JSON.stringify([
    { name: 'QA Deploy', command: 'echo qa deploy simulated', color: 'green' },
    { name: 'Smoke', command: 'echo qa smoke pass', color: 'blue' },
  ]);
  upsertProject.run(project.name, join(workspace, project.name), project.github, project.priority, actions, project.testCommand);
}

db.prepare('DELETE FROM skills WHERE id IN (?, ?, ?)').run('qa-release', 'qa-review', 'qa-docs');
const insertSkill = db.prepare('INSERT INTO skills (id, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
insertSkill.run('qa-release', 'QA release', 'Deterministic release-readiness checks for QA.', 'Use deterministic QA responses. Never call external systems.', now, now);
insertSkill.run('qa-review', 'QA review', 'LGTM-oriented mocked review skill.', 'Return a clear verdict using the project review rules.', now, now);
insertSkill.run('qa-docs', 'QA docs', 'Documentation smoke-check skill.', 'Check docs shape and summarize missing pieces.', now, now);

const upsertAgent = db.prepare(`
  INSERT INTO agents (id, name, project, skill_ids, model, prompt, schedule, runner, enabled, doc_paths, provider, prerequisite_command, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pm2', 1, ?, 'claude', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    project = excluded.project,
    skill_ids = excluded.skill_ids,
    model = excluded.model,
    prompt = excluded.prompt,
    schedule = excluded.schedule,
    enabled = 1,
    doc_paths = excluded.doc_paths,
    provider = 'claude',
    prerequisite_command = excluded.prerequisite_command,
    updated_at = excluded.updated_at
`);
for (const project of projects) {
  upsertAgent.run(
    `qa-${project.name}-release`,
    'QA release scout',
    project.name,
    JSON.stringify(['qa-release', 'qa-review']),
    'fast',
    `Inspect ${project.name} and report deterministic release readiness.`,
    '1h',
    JSON.stringify(['README.md']),
    'echo prerequisite ok',
    now,
    now,
  );
}

const upsertStatus = db.prepare('INSERT INTO gh_status (project, release_tag, ci, ci_failed_url, head_sha, local_head_sha, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET release_tag = excluded.release_tag, ci = excluded.ci, ci_failed_url = excluded.ci_failed_url, head_sha = excluded.head_sha, local_head_sha = excluded.local_head_sha, fetched_at = excluded.fetched_at');
for (const project of projects) {
  upsertStatus.run(project.name, 'v1.4.0-qa', project.name === 'web-console' ? 'failing' : 'passing', project.name === 'web-console' ? 'https://github.com/qa/web-console/actions/runs/1001' : null, 'abc123qa', 'abc123qa', new Date().toISOString());
}

const upsertIssues = db.prepare('INSERT INTO gh_issues_cache (project, repo, prs, issues, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET repo = excluded.repo, prs = excluded.prs, issues = excluded.issues, fetched_at = excluded.fetched_at');
for (const project of projects) {
  upsertIssues.run(
    project.name,
    project.github,
    JSON.stringify([{ number: 12, title: 'QA release pipeline smoke', url: `https://github.com/${project.github}/pull/12`, state: 'OPEN', headRefName: project.branch }]),
    JSON.stringify([{ number: 34, title: 'Exercise terminal QA shim', url: `https://github.com/${project.github}/issues/34`, state: 'OPEN', labels: [{ name: 'tamtam' }] }]),
    now,
  );
}

const upsertJob = db.prepare(`
  INSERT INTO jobs (id, project, kind, prompt, pid, log_path, started_at, finished_at, exit_code, duration_ms, input_tokens, output_tokens, verdict, cost_usd, model, work_summary, modified_files, provider)
  VALUES (?, ?, ?, ?, 99999, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'claude')
  ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at
`);
for (const project of projects) {
  const id = `${project.name}-qa-seeded-${Math.floor(now)}`;
  upsertJob.run(id, project.name, 'review', 'Seeded QA review', join(logDir, `${id}.log`), now - 7200, now - 7190, 10000, 320, 80, 'LGTM', 0, 'fast', 'Seeded QA review passed.', JSON.stringify(['src/index.ts']));
}

const upsertRecommendation = db.prepare(`
  INSERT INTO recommendations (id, project, source_kind, source_id, agent_id, agent_name, type, title, detail, status, payload, created_at, updated_at)
  VALUES (?, ?, 'agent:qa', ?, ?, 'QA release scout', 'qa_followup', ?, ?, 'open', '{}', ?, ?)
  ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at
`);
for (const project of projects) {
  upsertRecommendation.run(
    `qa-${project.name}-recommendation`,
    project.name,
    `qa-${project.name}-release`,
    `qa-${project.name}-release`,
    `Review seeded QA workflow for ${project.name}`,
    'This recommendation is seeded so the recommendations dashboard has actionable data in QA.',
    now,
    now,
  );
}

db.close();
console.log(`[qa-seed] seeded ${projects.length} projects at ${workspace}`);
