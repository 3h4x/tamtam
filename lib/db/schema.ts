import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  bigint,
  uniqueIndex,
  index,
  customType,
  serial,
} from 'drizzle-orm/pg-core';

// pgvector column type for 768-dimensional float vectors
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    if (Array.isArray(value)) return value as number[];
    // pgvector returns `'[0.1,0.2,...]'` — JSON-shaped, parses directly.
    return JSON.parse(value);
  },
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const projects = pgTable('projects', {
  name: text('name').primaryKey(),
  path: text('path').notNull(),
  enabled: boolean('enabled').default(false),
  github: text('github'),
  priority: text('priority'),
  customActions: text('custom_actions'),
  testCommand: text('test_command'),
  testsDisabled: boolean('tests_disabled').default(false),
  reviewDisabled: boolean('review_disabled').default(false),
  testCronEnabled: boolean('test_cron_enabled').default(false),
  testCronSchedule: text('test_cron_schedule'),
  autoCommitEnabled: boolean('auto_commit_enabled').default(false),
  autoPushEnabled: boolean('auto_push_enabled').default(false),
  autoPrMergeEnabled: boolean('auto_pr_merge_enabled').default(false),
  // Number of minutes after a PR merge during which TamTam watches the
  // default branch's CI on the merge commit. 0 disables the watcher.
  // When CI fails inside the window, a revert PR is opened (and
  // auto-merged when `auto_revert_enabled` is also on).
  postMergeWatchMinutes: integer('post_merge_watch_minutes').default(0),
  autoRevertEnabled: boolean('auto_revert_enabled').default(false),
  releaseAfterRun: boolean('release_after_run').default(false),
  issueAutoBranch: boolean('issue_auto_branch').default(true),
  lastPushError: text('last_push_error'),
  lastPushAt: doublePrecision('last_push_at'),
  reviewPromptAddendum: text('review_prompt_addendum'),
  // Bash command to run before each review step. Output is captured and
  // prepended to the review prompt so the reviewer can see anything that
  // ought to be regenerated before judging (DB types, codegen, schema
  // dumps). Optional — when null, review starts directly. Per-project so
  // codegen-heavy repos can opt in without affecting others.
  reviewPrerequisiteCommand: text('review_prerequisite_command'),
  fixPromptAddendum: text('fix_prompt_addendum'),
  website: text('website'),
  qaUrl: text('qa_url'),
  // Per-project dev server lifecycle. When `devServerStartCommand` is set,
  // TamTam starts it at agent run kickoff and stops it when the outermost
  // scope (agent run, or downstream release if release_after_run fired)
  // finishes. `devServerStopCommand` is optional — when null we send SIGTERM
  // to the spawned process group. `devServerReadyUrl` gates "ready" on a
  // 2xx/3xx HTTP probe; when null the spawn returns after a short grace
  // period. See lib/dev-server/lifecycle.ts.
  devServerStartCommand: text('dev_server_start_command'),
  devServerStopCommand: text('dev_server_stop_command'),
  devServerReadyUrl: text('dev_server_ready_url'),
  archived: boolean('archived').notNull().default(false),
  paused: boolean('paused').notNull().default(false),
});

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  kind: text('kind').notNull(),
  prompt: text('prompt'),
  pid: integer('pid').notNull(),
  logPath: text('log_path'),
  startedAt: doublePrecision('started_at').notNull(),
  finishedAt: doublePrecision('finished_at'),
  exitCode: integer('exit_code'),
  seen: boolean('seen').default(false),
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
  logPruned: boolean('log_pruned').default(false),
  verdict: text('verdict'),
  costUsd: doublePrecision('cost_usd'),
  model: text('model'),
  releaseId: text('release_id'),
  abortedAt: doublePrecision('aborted_at'),
  releaseDeadlineAt: bigint('release_deadline_at', { mode: 'number' }),
  promptBytes: integer('prompt_bytes'),
  workSummary: text('work_summary'),
  modifiedFiles: text('modified_files'),
  provider: text('provider'),
});

export const recommendations = pgTable('recommendations', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id'),
  agentId: text('agent_id'),
  agentName: text('agent_name'),
  type: text('type').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  status: text('status').notNull().default('open'),
  payload: text('payload'),
  createdAt: doublePrecision('created_at').notNull(),
  updatedAt: doublePrecision('updated_at').notNull(),
});

export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  content: text('content').notNull().default(''),
  createdAt: doublePrecision('created_at').notNull(),
  updatedAt: doublePrecision('updated_at').notNull(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  project: text('project').notNull(),
  skillIds: text('skill_ids').notNull().default('[]'),
  model: text('model').notNull().default('normal'),
  prompt: text('prompt').notNull().default(''),
  schedule: text('schedule'),
  enabled: boolean('enabled').notNull().default(true),
  docPaths: text('doc_paths').notNull().default('[]'),
  provider: text('provider'),
  fallbackEnabled: boolean('fallback_enabled').notNull().default(false),
  prerequisiteCommand: text('prerequisite_command'),
  // 'user' for normal user-defined agents (default), 'system' for built-in
  // agents auto-seeded per project that dispatch to internal handlers
  // instead of spawning a CLI. System agents share the table and the
  // scheduled-agent cron pipeline but do not go through the intake
  // workflow.
  kind: text('kind').notNull().default('user'),
  createdAt: doublePrecision('created_at').notNull(),
  updatedAt: doublePrecision('updated_at').notNull(),
});

export const ghStatus = pgTable('gh_status', {
  project: text('project').primaryKey(),
  releaseTag: text('release_tag'),
  ci: text('ci'),
  ciFailedUrl: text('ci_failed_url'),
  headSha: text('head_sha'),
  localHeadSha: text('local_head_sha'),
  fetchedAt: text('fetched_at').notNull(),
});

export const ghIssuesCache = pgTable('gh_issues_cache', {
  project: text('project').primaryKey(),
  repo: text('repo').notNull(),
  prs: text('prs').notNull().default('[]'),
  issues: text('issues').notNull().default('[]'),
  fetchedAt: doublePrecision('fetched_at').notNull(),
});

export const ghIssueDetailCache = pgTable('gh_issue_detail_cache', {
  id: serial('id').primaryKey(),
  project: text('project').notNull(),
  number: integer('number').notNull(),
  payload: text('payload').notNull(),
  fetchedAt: doublePrecision('fetched_at').notNull(),
}, (t) => ({
  projectNumberUniq: uniqueIndex('gh_issue_detail_cache_project_number').on(t.project, t.number),
}));

export const pipelineLocks = pgTable('pipeline_locks', {
  project: text('project').primaryKey(),
  lockedByJobId: text('locked_by_job_id').notNull(),
  acquiredAt: doublePrecision('acquired_at').notNull(),
});

export const queuedAgentRuns = pgTable('queued_agent_runs', {
  id: serial('id').primaryKey(),
  project: text('project').notNull(),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull(),
  triggeredBy: text('triggered_by').notNull().default('manual'),
  prompt: text('prompt').notNull().default(''),
  enqueuedAt: doublePrecision('enqueued_at').notNull(),
}, (t) => ({
  projectAgentUniq: uniqueIndex('queued_agent_runs_project_agent').on(t.project, t.agentId),
}));

// Durable job-completion event log. Written from markDone() before the
// completion-hook chain so any orchestration decision (release-after-run,
// release-after-fix-ci, auto-resume, …) can be re-driven by a workflow
// consumer reading unconsumed rows after a crash/restart, instead of
// being lost in the inline hook.
// `consumed_by` is set by the consumer to the workflow run id once the
// downstream decision dispatched, making consumption idempotent across
// restarts.
export const jobCompletionEvents = pgTable('job_completion_events', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull(),
  kind: text('kind').notNull(),
  exitCode: integer('exit_code'),
  project: text('project').notNull(),
  releaseId: text('release_id'),
  ghIssueNumber: integer('gh_issue_number'),
  emittedAt: doublePrecision('emitted_at').notNull(),
  consumedBy: text('consumed_by'),
  consumedAt: doublePrecision('consumed_at'),
}, (t) => ({
  jobIdUniq: uniqueIndex('job_completion_events_job_id').on(t.jobId),
  unconsumedIdx: index('job_completion_events_unconsumed').on(t.consumedBy, t.emittedAt),
}));

// Per-job resource samples (CPU %, RSS in KB) taken from the probe sweep.
// Each running job's PID is sampled via `ps -o %cpu,rss -p <pid>` every
// sweep tick (~30s) so per-job and per-project resource charts are
// possible without external observability. Append-only; prune in nightly
// cleanup. Indexed by (jobId, sampledAt) for cheap time-series reads.
export const jobResourceSamples = pgTable('job_resource_samples', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull(),
  sampledAt: doublePrecision('sampled_at').notNull(),
  cpuPct: doublePrecision('cpu_pct'),
  rssKb: integer('rss_kb'),
}, (t) => ({
  jobIdSampledAtIdx: index('job_resource_samples_job_sampled').on(t.jobId, t.sampledAt),
}));

// Durable pipeline-lock-released log. Written from releaseLock /
// selfHealStaleLock when a project's lock is dropped. A consumer
// (probe-sweep / workflow) reads unconsumed rows and drains
// pending-release + queued-agent-runs for that project, replacing the
// fire-and-forget `void drainPendingReleaseAsync(...)` call that loses
// the drain on a crash mid-release.
export const pipelineLockEvents = pgTable('pipeline_lock_events', {
  id: serial('id').primaryKey(),
  project: text('project').notNull(),
  releasedByJobId: text('released_by_job_id'),
  reason: text('reason').notNull(),
  emittedAt: doublePrecision('emitted_at').notNull(),
  consumedBy: text('consumed_by'),
  consumedAt: doublePrecision('consumed_at'),
}, (t) => ({
  unconsumedIdx: index('pipeline_lock_events_unconsumed').on(t.consumedBy, t.emittedAt),
}));

export const notificationThrottle = pgTable('notification_throttle', {
  key: text('key').primaryKey(),
  lastSentAt: bigint('last_sent_at', { mode: 'number' }).notNull(),
  suppressedCount: integer('suppressed_count').notNull().default(0),
});

export const maintenanceStatus = pgTable('maintenance_status', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: doublePrecision('updated_at').notNull(),
});

export const retrievalRecords = pgTable('retrieval_records', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  contentHash: text('content_hash').notNull(),
  indexedAt: doublePrecision('indexed_at').notNull(),
  // Embedding model name that produced this record's chunks. Used by the
  // documentation-reindex-vectors system agent to detect when the configured
  // model has drifted from what's already in the index, triggering a
  // wipe-and-reindex (old-dim vectors cannot be safely searched against
  // new-model queries).
  embeddingModel: text('embedding_model'),
});

export const retrievalChunks = pgTable('retrieval_chunks', {
  id: serial('id').primaryKey(),
  chunkId: text('chunk_id').notNull().unique(),
  project: text('project').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  metadata: text('metadata').notNull(),
  embedding: vector('embedding'),
});

export const ollamaUsage = pgTable('ollama_usage', {
  id: serial('id').primaryKey(),
  ts: doublePrecision('ts').notNull(),
  model: text('model').notNull(),
  project: text('project'),
  sourceKind: text('source_kind'),
  inputTokens: integer('input_tokens').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
}, (t) => ({
  tsIdx: index('ollama_usage_ts').on(t.ts),
}));
