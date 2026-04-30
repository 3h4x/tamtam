export type SettingsFieldKey = 'workspace_path' | 'github_owner' | 'claude_provider' | 'claude_bin' | 'lmstudio_model' | 'log_dir' | 'frequency' | 'daytime' | 'weekends' | 'launchagent_prefix' | 'base_prompt' | 'default_model' | 'permission_mode' | 'commit_style' | 'review_verdict_rules' | 'fix_ci_max_retries' | 'fix_ci_retry_window_seconds' | 'fix_ci_fast_crash_ms' | 'agent_templates' | 'log_retention_count' | 'log_retention_days' | 'job_row_retention_days' | 'notification_webhook_url' | 'notification_webhook_secret' | 'notification_on_release_success' | 'notification_on_release_fail' | 'notification_on_release_aborted' | 'notification_on_fix_loop_exhausted' | 'notification_on_review_do_not_ship' | 'notification_on_agent_run_fail' | 'pipeline_model_review' | 'pipeline_model_fix' | 'pipeline_model_dod' | 'pipeline_model_commit'

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
    help: 'Used for Claude or Custom provider. Gemini and LM Studio resolve to TamTam shim scripts.',
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
    label: 'Default Model',
    help: 'Model pre-selected in the terminal runner',
    group: 'agent',
    span: 1,
  },
  permission_mode: {
    label: 'Permission Mode',
    help: 'Controls which operations Claude can perform without prompting',
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
  launchagent_prefix: {
    label: 'LaunchAgent Prefix',
    help: 'Prefix for macOS LaunchAgent plist labels',
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
  fix_ci_max_retries: {
    label: 'Fix-CI Max Retries',
    help: 'How many times to auto-retry a fix-ci job that crashes fast before giving up. 0 disables retries.',
    group: 'pipeline',
    span: 1,
  },
  fix_ci_retry_window_seconds: {
    label: 'Fix-CI Retry Window (s)',
    help: 'Window in seconds within which retries are counted toward the cap',
    group: 'pipeline',
    advanced: true,
    span: 1,
  },
  fix_ci_fast_crash_ms: {
    label: 'Fix-CI Fast-Crash (ms)',
    help: 'Duration under which a non-zero exit is treated as a boot crash and retried. Longer failures surface as-is.',
    group: 'pipeline',
    advanced: true,
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
  pipeline_model_review: {
    label: 'Review Model',
    help: 'Model used for code review. "Default" uses the workspace Default Model.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_fix: {
    label: 'Fix Model',
    help: 'Model used for the fix step. "Default" uses the workspace Default Model.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_dod: {
    label: 'DoD Model',
    help: 'Model used for DoD verification. Empty defaults to haiku — verification is read-only and cheap.',
    group: 'pipeline',
    span: 1,
  },
  pipeline_model_commit: {
    label: 'Commit Message Model',
    help: 'Model used to generate commit messages. Empty defaults to haiku — short well-scoped task.',
    group: 'pipeline',
    span: 1,
  },
}

export const DEFAULTS: Record<SettingsFieldKey, string> = {
  workspace_path: '',
  github_owner: '',
  claude_provider: 'claude',
  claude_bin: '~/.local/bin/claude',
  lmstudio_model: '',
  log_dir: './data/logs',
  frequency: '1h',
  daytime: 'false',
  weekends: 'off',
  launchagent_prefix: 'com.tamtam',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'haiku',
  permission_mode: 'bypassPermissions',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `STRICT verdict rules — the user cares about code quality, not speed:
- LGTM ONLY when there are zero findings at any severity. Not "LGTM with minor notes", not "LGTM aside from a nit". If you list any "minor" / "non-blocking" / "cosmetic" / "consider..." / "nice-to-have" issue, that is NEEDS ATTENTION, not LGTM.
- NEEDS ATTENTION when you have at least one finding but nothing that risks data loss, security regressions, or breakage in production. Orphaned code, dead imports, missing imports that happen to compile, hardcoded strings that should use env vars, non-ideal UX state leaks, stylistic inconsistencies — all NEEDS ATTENTION.
- DO NOT SHIP when there is a real risk of breakage, data loss, security regression, or a test that hides behavior.
- If LGTM, just confirm the changes look good and add nothing else.`,
  fix_ci_max_retries: '2',
  fix_ci_retry_window_seconds: '120',
  fix_ci_fast_crash_ms: '5000',
  agent_templates: '',
  log_retention_count: '200',
  log_retention_days: '30',
  job_row_retention_days: '180',
  notification_webhook_url: '',
  notification_webhook_secret: '',
  notification_on_release_success: 'false',
  notification_on_release_fail: 'false',
  notification_on_release_aborted: 'false',
  notification_on_fix_loop_exhausted: 'false',
  notification_on_review_do_not_ship: 'false',
  notification_on_agent_run_fail: 'false',
  pipeline_model_review: '',
  pipeline_model_fix: '',
  pipeline_model_dod: '',
  pipeline_model_commit: '',
}

const FIELD_BASE = 'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors'
export const SELECT_CLASS = `${FIELD_BASE} appearance-none cursor-pointer bg-no-repeat bg-[right_0.6rem_center] pr-9 bg-[length:1rem] bg-[image:url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27%2F%3E%3C%2Fsvg%3E")]`
export const INPUT_CLASS  = `${FIELD_BASE} font-mono placeholder:text-text-tertiary`
export const COL_SPAN: Record<number, string> = { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3' }
export const GRID_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3' }
