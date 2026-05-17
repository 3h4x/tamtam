#!/usr/bin/env node

import pg from 'pg';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[qa-seed] DATABASE_URL not set');
  process.exit(1);
}

const workspace = process.env.TAMTAM_QA_WORKSPACE || '/qa/workspace';
const logDir = process.env.TAMTAM_QA_LOG_DIR || '/qa/logs';
const now = Date.now() / 1000;

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
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo qa test pass' } }, null, 2),
  );
  writeFileSync(join(root, 'src', 'index.ts'), `export const projectName = '${project.name}';\n`);
  writeFileSync(
    join(root, '.tamtam', 'config.yml'),
    `pipeline:\n  test_command: ${project.testCommand}\n`,
  );
  writeFileSync(
    join(root, '.tamtam', 'agents', 'release-check.md'),
    `---\nprovider: claude\nmodel: fast\nschedule: 1h\nskillIds: ["qa-release"]\nenabled: true\n---\nRun a deterministic QA release readiness check for ${project.name}.\n`,
  );
  writeFileSync(join(root, '.qa-state.json'), JSON.stringify(project, null, 2));
}

const pool = new Pool({ connectionString: dbUrl, max: 2 });
try {
  const settings = {
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
  };
  for (const [key, value] of Object.entries(settings)) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  for (const project of projects) {
    const actions = JSON.stringify([
      { name: 'QA Deploy', command: 'echo qa deploy simulated', color: 'green' },
      { name: 'Smoke', command: 'echo qa smoke pass', color: 'blue' },
    ]);
    await pool.query(
      `INSERT INTO projects (
         name, path, enabled, github, priority, custom_actions, test_command,
         test_cron_enabled, test_cron_schedule, auto_commit_enabled, auto_push_enabled,
         auto_pr_merge_enabled, release_after_run, issue_auto_branch
       ) VALUES ($1, $2, true, $3, $4, $5, $6, true, '30m', true, true, false, false, true)
       ON CONFLICT (name) DO UPDATE SET
         path = EXCLUDED.path,
         enabled = true,
         github = EXCLUDED.github,
         priority = EXCLUDED.priority,
         custom_actions = EXCLUDED.custom_actions,
         test_command = EXCLUDED.test_command,
         test_cron_enabled = true,
         test_cron_schedule = '30m',
         auto_commit_enabled = true,
         auto_push_enabled = true`,
      [
        project.name,
        join(workspace, project.name),
        project.github,
        project.priority,
        actions,
        project.testCommand,
      ],
    );
  }

  await pool.query(`DELETE FROM skills WHERE id = ANY($1::text[])`, [
    ['qa-release', 'qa-review', 'qa-docs'],
  ]);
  const seedSkill = async (id, name, description, content) => {
    await pool.query(
      `INSERT INTO skills (id, name, description, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, name, description, content, now],
    );
  };
  await seedSkill(
    'qa-release',
    'QA release',
    'Deterministic release-readiness checks for QA.',
    'Use deterministic QA responses. Never call external systems.',
  );
  await seedSkill(
    'qa-review',
    'QA review',
    'LGTM-oriented mocked review skill.',
    'Return a clear verdict using the project review rules.',
  );
  await seedSkill(
    'qa-docs',
    'QA docs',
    'Documentation smoke-check skill.',
    'Check docs shape and summarize missing pieces.',
  );

  for (const project of projects) {
    await pool.query(
      `INSERT INTO agents (
         id, name, project, skill_ids, model, prompt, schedule, enabled,
         doc_paths, provider, prerequisite_command, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'claude', $9, $10, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         project = EXCLUDED.project,
         skill_ids = EXCLUDED.skill_ids,
         model = EXCLUDED.model,
         prompt = EXCLUDED.prompt,
         schedule = EXCLUDED.schedule,
         enabled = true,
         doc_paths = EXCLUDED.doc_paths,
         provider = 'claude',
         prerequisite_command = EXCLUDED.prerequisite_command,
         updated_at = EXCLUDED.updated_at`,
      [
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
      ],
    );
  }

  for (const project of projects) {
    await pool.query(
      `INSERT INTO gh_status (project, release_tag, ci, ci_failed_url, head_sha, local_head_sha, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT (project) DO UPDATE SET
         release_tag = EXCLUDED.release_tag,
         ci = EXCLUDED.ci,
         ci_failed_url = EXCLUDED.ci_failed_url,
         head_sha = EXCLUDED.head_sha,
         local_head_sha = EXCLUDED.local_head_sha,
         fetched_at = EXCLUDED.fetched_at`,
      [
        project.name,
        'v1.4.0-qa',
        project.name === 'web-console' ? 'failing' : 'passing',
        project.name === 'web-console'
          ? 'https://github.com/qa/web-console/actions/runs/1001'
          : null,
        'abc123qa',
        new Date().toISOString(),
      ],
    );
  }

  for (const project of projects) {
    await pool.query(
      `INSERT INTO gh_issues_cache (project, repo, prs, issues, fetched_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project) DO UPDATE SET
         repo = EXCLUDED.repo,
         prs = EXCLUDED.prs,
         issues = EXCLUDED.issues,
         fetched_at = EXCLUDED.fetched_at`,
      [
        project.name,
        project.github,
        JSON.stringify([
          {
            number: 12,
            title: 'QA release pipeline smoke',
            url: `https://github.com/${project.github}/pull/12`,
            state: 'OPEN',
            headRefName: project.branch,
            baseRefName: 'main',
            author: { login: 'qa-bot' },
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            updatedAt: new Date(Date.now() - 1800000).toISOString(),
            isDraft: false,
            reviewDecision: null,
            labels: [],
            body: '',
            statusCheckRollup: null,
          },
        ]),
        JSON.stringify([
          {
            number: 34,
            title: 'Exercise terminal QA shim',
            url: `https://github.com/${project.github}/issues/34`,
            state: 'OPEN',
            author: { login: 'qa-bot' },
            createdAt: new Date(Date.now() - 7200000).toISOString(),
            updatedAt: new Date(Date.now() - 3600000).toISOString(),
            assignees: [],
            labels: [{ name: 'tamtam', color: '0075ca' }],
            body: '',
          },
        ]),
        now,
      ],
    );
  }

  for (const project of projects) {
    const id = `${project.name}-qa-seeded-${Math.floor(now)}`;
    await pool.query(
      `INSERT INTO jobs (
         id, project, kind, prompt, pid, log_path, started_at, finished_at, exit_code,
         duration_ms, input_tokens, output_tokens, verdict, cost_usd, model, work_summary,
         modified_files, provider
       ) VALUES ($1, $2, $3, $4, 99999, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15, 'claude')
       ON CONFLICT (id) DO UPDATE SET finished_at = EXCLUDED.finished_at`,
      [
        id,
        project.name,
        'review',
        'Seeded QA review',
        join(logDir, `${id}.log`),
        now - 7200,
        now - 7190,
        10000,
        320,
        80,
        'LGTM',
        0,
        'fast',
        'Seeded QA review passed.',
        JSON.stringify(['src/index.ts']),
      ],
    );
  }

  for (const project of projects) {
    await pool.query(
      `INSERT INTO recommendations (
         id, project, source_kind, source_id, agent_id, agent_name, type, title, detail,
         status, payload, created_at, updated_at
       ) VALUES ($1, $2, 'agent:qa', $3, $4, 'QA release scout', 'qa_followup', $5, $6, 'open', '{}', $7, $7)
       ON CONFLICT (id) DO UPDATE SET detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`,
      [
        `qa-${project.name}-recommendation`,
        project.name,
        `qa-${project.name}-release`,
        `qa-${project.name}-release`,
        `Review seeded QA workflow for ${project.name}`,
        'This recommendation is seeded so the recommendations dashboard has actionable data in QA.',
        now,
      ],
    );
  }
} finally {
  await pool.end();
}

console.log(`[qa-seed] seeded ${projects.length} projects at ${workspace}`);
