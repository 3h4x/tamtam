import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const projects = sqliteTable('projects', {
  name: text('name').primaryKey(),
  path: text('path').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(false),
  github: text('github'),
  priority: text('priority'),
  customActions: text('custom_actions'),
  testCommand: text('test_command'),
  testsDisabled: integer('tests_disabled', { mode: 'boolean' }).default(false),
  reviewDisabled: integer('review_disabled', { mode: 'boolean' }).default(false),
  testCronEnabled: integer('test_cron_enabled', { mode: 'boolean' }).default(false),
  testCronSchedule: text('test_cron_schedule'),
  autoCommitEnabled: integer('auto_commit_enabled', { mode: 'boolean' }).default(false),
  autoPushEnabled: integer('auto_push_enabled', { mode: 'boolean' }).default(false),
  autoPrMergeEnabled: integer('auto_pr_merge_enabled', { mode: 'boolean' }).default(false),
  releaseAfterRun: integer('release_after_run', { mode: 'boolean' }).default(true),
  prWorkflowEnabled: integer('pr_workflow_enabled', { mode: 'boolean' }).default(false),
  issueAutoBranch: integer('issue_auto_branch', { mode: 'boolean' }).default(true),
  lastPushError: text('last_push_error'),
  lastPushAt: real('last_push_at'),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  kind: text('kind').notNull(),
  prompt: text('prompt'),
  pid: integer('pid').notNull(),
  logPath: text('log_path'),
  startedAt: real('started_at').notNull(),
  finishedAt: real('finished_at'),
  exitCode: integer('exit_code'),
  seen: integer('seen', { mode: 'boolean' }).default(false),
  durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheCreateTokens: integer('cache_create_tokens'),
  sessionId: text('session_id'),
  userPrompt: text('user_prompt'),
  contextMeta: text('context_meta'),
  parentJobId: text('parent_job_id'),
  ghIssueNumber: integer('gh_issue_number'),
  ghIssueRepo: text('gh_issue_repo'),
  ghIssueTitle: text('gh_issue_title'),
  logPruned: integer('log_pruned', { mode: 'boolean' }).default(false),
  costUsd: real('cost_usd'),
  model: text('model'),
  releaseId: text('release_id'),
  abortedAt: real('aborted_at'),
  promptBytes: integer('prompt_bytes'),
});

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  content: text('content').notNull().default(''),
  createdAt: real('created_at').notNull(),
  updatedAt: real('updated_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  project: text('project').notNull(),
  skillIds: text('skill_ids').notNull().default('[]'),  // JSON array of skill IDs
  model: text('model').notNull().default('sonnet'),
  prompt: text('prompt').notNull().default(''),  // default task prompt for scheduled runs
  schedule: text('schedule'),  // e.g. "1h", "30m", "8h", null = manual only
  runner: text('runner').notNull().default('pm2'),  // "launchctl" or "pm2"
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  docPaths: text('doc_paths').notNull().default('[]'),  // JSON array of project-relative doc paths
  createdAt: real('created_at').notNull(),
  updatedAt: real('updated_at').notNull(),
});

export const ghStatus = sqliteTable('gh_status', {
  project: text('project').primaryKey(),
  releaseTag: text('release_tag'),
  ci: text('ci'),
  ciFailedUrl: text('ci_failed_url'),
  headSha: text('head_sha'),
  localHeadSha: text('local_head_sha'),
  fetchedAt: text('fetched_at').notNull(),
});

export const ghIssuesCache = sqliteTable('gh_issues_cache', {
  project: text('project').primaryKey(),
  repo: text('repo').notNull(),
  prs: text('prs').notNull().default('[]'),
  issues: text('issues').notNull().default('[]'),
  fetchedAt: real('fetched_at').notNull(),
});

export const pipelineLocks = sqliteTable('pipeline_locks', {
  project: text('project').primaryKey(),
  lockedByJobId: text('locked_by_job_id').notNull(),
  acquiredAt: real('acquired_at').notNull(),
});
