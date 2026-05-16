export type SettingsFieldKey = 'workspace_path' | 'github_owner' | 'trusted_github_users' | 'claude_provider' | 'claude_bin' | 'lmstudio_model' | 'log_dir' | 'frequency' | 'daytime' | 'weekends' | 'base_prompt' | 'default_model' | 'permission_mode' | 'commit_style' | 'review_verdict_rules' | 'review_fix_max_iterations' | 'review_do_not_ship_action' | 'release_wall_clock_timeout_minutes' | 'legacy_completion_hook_release_after_run_enabled' | 'legacy_completion_hook_release_after_fix_ci_enabled' | 'legacy_completion_hook_auto_resume_enabled' | 'legacy_pipeline_lock_inline_drain_enabled' |'agent_templates' | 'log_retention_count' | 'log_retention_days' | 'job_row_retention_days' | 'workflow_run_retention_days' | 'backup_retention_count' | 'backup_retention_weekly_count' | 'notification_webhook_url' | 'notification_webhook_secret' | 'notification_on_release_success' | 'notification_on_release_fail' | 'notification_on_release_aborted' | 'notification_on_fix_loop_exhausted' | 'notification_on_review_do_not_ship' | 'notification_on_agent_run_fail' | 'notification_throttle_window_seconds' | 'notification_throttle_overrides' | 'pipeline_model_review' | 'pipeline_model_fix' | 'pipeline_model_dod' | 'pipeline_model_commit' | 'project_sweep_enabled' | 'dirty_worktree_block_threshold' | 'incremental_review_enabled'

export interface FieldDef {
  label: string
  help: string
  group: 'agent' | 'pipeline' | 'general'
  advanced?: boolean
  span?: number
}

export const FIELDS: Record<SettingsFieldKey, FieldDef> = {
  workspace_path: {
    label: 'Workspace Path',
    help: 'Root directory containing your git projects',
    group: 'general',
    span: 2,
  },
  github_owner: {
    label: 'GitHub Owner',
    help: 'Default GitHub org/user for repos without an explicit remote',
    group: 'general',
    span: 1,
  },
  trusted_github_users: {
    label: 'Trusted GitHub Users',
    help: 'Global allowlist for issue/PR authors whose GitHub content TamTam may treat as trusted. Managed through the dedicated editor in Settings → General.',
    group: 'general',
    span: 2,
  },
  claude_provider: {
    label: 'Agent CLI Provider',
    help: 'Choose the Claude-compatible backend TamTam invokes for runs',
    group: 'agent',
    span: 1,
  },
  frequency: {
    label: 'Base Frequency',
    help: 'How often scheduled agents run, e.g. "1h", "30m"',
    group: 'general',
    span: 1,
  },
  daytime: {
    label: 'Allowed Hours',
    help: 'Time window when agents are permitted to run',
    group: 'general',
    span: 1,
  },
  weekends: {
    label: 'Weekend Runs',
    help: 'Whether agents run on Saturdays and Sundays',
    group: 'general',
    span: 1,
  },
  claude_bin: {
    label: 'Claude CLI Path',
    help: 'Used for Claude or Custom provider. Gemini, LM Studio, and Codex resolve to TamTam shim scripts.',
    group: 'agent',
    span: 1,
  },
  lmstudio_model: {
    label: 'Default Model',
    help: 'Downloaded LM Studio model identifier used as the default model for runs',
    group: 'agent',
    span: 1,
  },
  default_model: {
    label: 'Default Model Tier',
    help: 'Capability tier pre-selected in the terminal runner',
    group: 'agent',
    span: 1,
  },
  permission_mode: {
    label: 'Permission Mode',
    help: 'Permission flag passed to TamTam-spawned headless runs. acceptEdits (recommended) keeps write-enabled runs non-interactive across the bundled Claude, Gemini, and Codex shims. bypassPermissions skips all approval checks. auto preserves provider-native behavior and can still block unattended runs on some CLIs. plan is read-only.',
    group: 'agent',
    span: 1,
  },
  log_dir: {
    label: 'Log Directory',
    help: 'Directory where job logs are stored',
    group: 'general',
    advanced: true,
    span: 1,
  },
  base_prompt: {
    label: 'Base Prompt',
    help: 'Prepended to every Claude invocation — runs, agents, and reviews',
    group: 'agent',
    span: 2,
  },
  commit_style: {
    label: 'Commit Message Style',
    help: 'Style guide injected into the prompt when generating commit titles in the Push panel',
    group: 'pipeline',
    span: 2,
  },
  review_verdict_rules: {
    label: 'Review Verdict Rules',
    help: 'Rules that drive LGTM / NEEDS ATTENTION / DO NOT SHIP decisions in code reviews',
    group: 'pipeline',
    span: 2,
  },
  review_fix_max_iterations: {
    label: 'Review Fix Loop Iterations',
    help: 'How many NEEDS ATTENTION review→fix verification rounds to attempt per release before filing a follow-up issue with the unresolved findings and shipping the partial work. This setting only governs review-side exhaustion; test/commit/push safety caps still use the shared advanced env guard. DO NOT SHIP reviews follow the policy below. Default 3.',
    group: 'pipeline',
    span: 1,
  },
  review_do_not_ship_action: {
    label: 'Do Not Ship Action',
    help: 'Policy for DO NOT SHIP review verdicts. pass files a follow-up issue and continues to commit; fix tries the review fix loop; abort stops before commit.',
    group: 'pipeline',
    span: 1,
  },
  release_wall_clock_timeout_minutes: {
    label: 'Release Timeout (minutes)',
    help: 'Overall wall-clock budget for a Release run before the recovery sweep aborts it as timed out. Default 60.',
    group: 'pipeline',
    span: 1,
  },
  legacy_completion_hook_release_after_run_enabled: {
    label: 'Legacy Release-After-Run Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts release-after-run. Disable while routing release triggers through the workflow event path.',
    group: 'pipeline',
    span: 1,
  },
  legacy_completion_hook_release_after_fix_ci_enabled: {
    label: 'Legacy Release-After-Fix-CI Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts release-after-fix-CI. Disable while routing fix-CI triggers through the workflow event path.',
    group: 'pipeline',
    span: 1,
  },
  legacy_completion_hook_auto_resume_enabled: {
    label: 'Legacy Auto-Resume Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts auto-resume. Disable while routing auto-resume triggers through the workflow event path.',
    group: 'pipeline',
    span: 1,
  },
  legacy_pipeline_lock_inline_drain_enabled: {
    label: 'Legacy Pipeline Lock Drain',
    help: 'Runtime kill switch for inline pending-release and queued-agent draining after a pipeline lock is released. Disable while routing lock-release drains through the durable event path.',
    group: 'pipeline',
    span: 1,
  },
  agent_templates: {
    label: 'Agent Templates',
    help: 'JSON array of custom agent templates (managed via the Templates tab)',
    group: 'templates' as never,
    span: 2,
  },
  log_retention_count: {
    label: 'Log Retention (runs)',
    help: 'Keep log files for the last N finished runs per project. Older log files are deleted; the run row stays in history.',
    group: 'pipeline',
    span: 1,
  },
  log_retention_days: {
    label: 'Log Retention (days)',
    help: 'Delete log files for runs older than this many days. Set to 0 to disable age-based pruning.',
    group: 'pipeline',
    span: 1,
  },
  job_row_retention_days: {
    label: 'Run History Retention (days)',
    help: 'Nightly cleanup: delete run DB rows older than this many days. Set to 0 to disable.',
    group: 'pipeline',
    span: 1,
  },
  workflow_run_retention_days: {
    label: 'Workflow Trace Retention (days)',
    help: 'Nightly cleanup: delete completed workflow runtime traces older than this many days. Set to 0 to disable.',
    group: 'pipeline',
    span: 1,
  },
  backup_retention_count: {
    label: 'Backup Retention (files)',
    help: 'Keep this many newest Postgres backup files after each successful backup. Set to 0 to prune all older backups after each run while still keeping the newly created backup.',
    group: 'pipeline',
    span: 1,
  },
  backup_retention_weekly_count: {
    label: 'Weekly Backup Retention',
    help: 'Also keep one older backup per week for this many weeks after the newest backups. Set to 0 to disable weekly retention.',
    group: 'pipeline',
    span: 1,
  },
  notification_webhook_url: {
    label: 'Notification Webhook URL',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_webhook_secret: {
    label: 'Notification Webhook Secret',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_success: {
    label: 'Notification on Release Success',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_fail: {
    label: 'Notification on Release Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_aborted: {
    label: 'Notification on Release Aborted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_fix_loop_exhausted: {
    label: 'Notification on Fix Loop Exhausted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_review_do_not_ship: {
    label: 'Notification on Review Do Not Ship',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_agent_run_fail: {
    label: 'Notification on Agent Run Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_throttle_window_seconds: {
    label: 'Notification Throttle Window',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_throttle_overrides: {
    label: 'Notification Throttle Overrides',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  pipeline_model_review: {
    label: 'Review Tier',
    help: 'Capability tier used for code review. "Default" uses the workspace Default Model Tier.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_fix: {
    label: 'Fix Tier',
    help: 'Capability tier used for the fix step. "Default" uses the workspace Default Model Tier.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_dod: {
    label: 'DoD Tier',
    help: 'Capability tier used for DoD verification. Empty defaults to Fast — verification is read-only and cheap.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_commit: {
    label: 'Commit Message Tier',
    help: 'Capability tier used to generate commit messages. Empty defaults to Fast — short well-scoped task.',
    group: 'pipeline',
    span: 1,
  },
  project_sweep_enabled: {
    label: 'Project Sweep',
    help: 'Run the background project sweep worker when TamTam starts.',
    group: 'pipeline',
    span: 1,
  },
  dirty_worktree_block_threshold: {
    label: 'Dirty Worktree Block Threshold',
    help: 'Block agent runs when the project has at least this many uncommitted files (incl. untracked). Default 1 blocks on any dirty worktree; set higher to allow small WIP, 0 to disable.',
    group: 'pipeline',
    span: 1,
  },
  incremental_review_enabled: {
    label: 'Incremental Review',
    help: 'After an LGTM verdict, narrow the next review diff to commits since the last LGTM (uses a refs/tamtam/reviewed/<branch> ref).',
    group: 'pipeline',
    span: 1,
  },
}

export const DEFAULTS: Record<SettingsFieldKey, string> = {
  workspace_path: '',
  github_owner: '',
  trusted_github_users: '',
  claude_provider: 'claude',
  claude_bin: '~/.local/bin/claude',
  lmstudio_model: '',
  log_dir: './data/logs',
  frequency: '1h',
  daytime: 'false',
  weekends: 'off',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'fast',
  permission_mode: 'acceptEdits',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `STRICT verdict rules — the user cares about code quality, not speed:
- LGTM ONLY when there are zero findings at any severity. Not "LGTM with minor notes", not "LGTM aside from a nit". If you list any "minor" / "non-blocking" / "cosmetic" / "consider..." / "nice-to-have" issue, that is NEEDS ATTENTION, not LGTM.
- NEEDS ATTENTION when you have at least one finding but nothing that risks data loss, security regressions, or breakage in production. Orphaned code, dead imports, missing imports that happen to compile, hardcoded strings that should use env vars, non-ideal UX state leaks, stylistic inconsistencies — all NEEDS ATTENTION.
- DO NOT SHIP when there is a real risk of breakage, data loss, security regression, or a test that hides behavior.
- If LGTM, just confirm the changes look good and add nothing else.`,
  review_fix_max_iterations: '3',
  review_do_not_ship_action: 'pass',
  release_wall_clock_timeout_minutes: '60',
  legacy_completion_hook_release_after_run_enabled: 'true',
  legacy_completion_hook_release_after_fix_ci_enabled: 'true',
  legacy_completion_hook_auto_resume_enabled: 'true',
  legacy_pipeline_lock_inline_drain_enabled: 'true',
  agent_templates: '',
  log_retention_count: '200',
  log_retention_days: '30',
  job_row_retention_days: '180',
  workflow_run_retention_days: '30',
  backup_retention_count: '14',
  backup_retention_weekly_count: '8',
  notification_webhook_url: '',
  notification_webhook_secret: '',
  notification_on_release_success: 'false',
  notification_on_release_fail: 'false',
  notification_on_release_aborted: 'false',
  notification_on_fix_loop_exhausted: 'false',
  notification_on_review_do_not_ship: 'false',
  notification_on_agent_run_fail: 'false',
  notification_throttle_window_seconds: '900',
  notification_throttle_overrides: '{"release_fail":0,"release_aborted":0}',
  pipeline_model_review: '',
  pipeline_model_fix: '',
  pipeline_model_dod: '',
  pipeline_model_commit: '',
  project_sweep_enabled: 'false',
  dirty_worktree_block_threshold: '1',
  incremental_review_enabled: 'true',
}

const FIELD_BASE = 'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors'
export const SELECT_CLASS = `${FIELD_BASE} appearance-none cursor-pointer bg-no-repeat bg-[right_0.6rem_center] pr-9 bg-[length:1rem] bg-[image:url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27%2F%3E%3C%2Fsvg%3E")]`
export const INPUT_CLASS  = `${FIELD_BASE} font-mono placeholder:text-text-tertiary`
export const COL_SPAN: Record<number, string> = { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3' }
export const GRID_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3' }
