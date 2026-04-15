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
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  kind: text('kind').notNull(),
  pid: integer('pid').notNull(),
  logPath: text('log_path'),
  startedAt: real('started_at').notNull(),
  finishedAt: real('finished_at'),
  exitCode: integer('exit_code'),
  seen: integer('seen', { mode: 'boolean' }).default(false),
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
