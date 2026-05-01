# Settings Reference

All settings stored in the `settings` table (key-value, both TEXT). Accessed via `lib/config.ts` (`getSettings()`, `TamTamConfig`). Config is cached with a 5s TTL; `PATCH /api/settings` calls `reloadConfig()` to invalidate.

## When to read this

- Pointing tamtam at a different workspace or Claude binary
- Tuning review verdict strictness (`review_verdict_rules`)
- Changing commit message style (`commit_style`)
- Adjusting fix-CI retry behavior after flaky test failures
- Restricting agent runs to specific hours (`daytime`, `weekends`)

---

## All Keys

### Workspace

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `workspace_path` | string | `''` | Root directory scanned for git repos; drives the projects list |
| `github_owner` | string | `''` | Default GitHub org/user for repos without an explicit remote URL |

### Claude CLI

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `claude_bin` | string | `~/.local/bin/claude` | Path to Claude CLI binary; used for every review/fix/run/agent job |
| `permission_mode` | string | `bypassPermissions` | Passed as `--permission-mode` flag. Allowed: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan` — invalid values fall back to `bypassPermissions` |
| `default_model` | string | `haiku` | Pre-selected model in the terminal UI. Options: `haiku`, `sonnet`, `opus` |

### Scheduling

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `frequency` | string | `1h` | Base interval for agent runs (e.g. `30m`, `1h`, `8h`) |
| `daytime` | boolean | `false` | Stored as `'true'`/`'false'`. If true, agents run 24/7; if false, night-only (20:00–05:59) |
| `weekends` | boolean | `false` | Stored as `'on'`/`'off'`. If true, agents run Sat/Sun |

### Behavior

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `base_prompt` | string | Long system prompt | Prepended to every Claude invocation — reviews, fixes, runs, agents |
| `commit_style` | string | Conventional commits guide | Injected into the push commit-message generation prompt |
| `review_verdict_rules` | string | Pragmatic rules | Injected into review prompts; drives LGTM / NEEDS ATTENTION / DO NOT SHIP decisions |

### Notifications

Outbound webhooks for release pipeline events. Never blocks pipeline progress — deliverability is best-effort with 3 retries.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `notification_webhook_url` | string | `''` | Webhook endpoint URL. Supports Slack (`hooks.slack.com`), Discord (`discord.com/api/webhooks`), ntfy, and generic JSON POST endpoints. Leave blank to disable notifications. |
| `notification_webhook_secret` | string | `''` | Optional secret for HMAC-SHA256 signature verification. If set, payloads include `X-TamTam-Signature` header. |
| `notification_on_release_success` | boolean | `false` | Stored as `'true'`/`'false'`. Notify when a release pipeline completes successfully. |
| `notification_on_release_fail` | boolean | `false` | Notify when a release pipeline fails. |
| `notification_on_fix_loop_exhausted` | boolean | `false` | Notify when the fix loop reaches its maximum iteration count (prevents infinite review→fix cycles). |
| `notification_on_review_do_not_ship` | boolean | `false` | Notify when a code review verdict is "DO NOT SHIP". |
| `notification_on_agent_run_fail` | boolean | `false` | Notify when an agent run fails. |

**Payload format:** 
- **Slack**: Formatted as block kit with event, project, status, verdict (if review), cost (if available), and a log link.
- **Discord**: Embedded message with event details and a timestamp.
- **Generic**: JSON POST with `{ event, project, job_id, status, verdict?, agent?, cost_usd?, log_url?, timestamp }`.

**Test notification:** Use the "Send Test" button in the Notifications tab to verify webhook connectivity before enabling production events.

### Fix-CI Auto-Retry

All three are read live on each job (not cached), so changing them takes effect immediately.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `fix_ci_max_retries` | number | `2` | Max auto-retries for `fix-ci` jobs on fast crashes. Set to `0` to disable. |
| `fix_ci_retry_window_seconds` | number | `120` | Sliding window for counting retry attempts |
| `fix_ci_fast_crash_ms` | number | `5000` | Jobs that exit in under this many ms are considered boot failures and retried; jobs over this are surfaced as real errors |

### Log & History Retention

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_retention_count` | number | `200` | Keep log files for the last N finished runs per project. On each run completion, the oldest log files beyond this count are deleted and the DB row is flagged `log_pruned`. Set to `0` to disable count-based pruning. |
| `log_retention_days` | number | `30` | Delete log files older than this many days (per project, evaluated on each run completion). Set to `0` to disable age-based pruning. |
| `job_row_retention_days` | number | `180` | Nightly cleanup: delete finished `jobs` DB rows older than this many days. Set to `0` to disable. Run rows older than this threshold are permanently removed. |

### System

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_dir` | string | `./data/logs` | Directory where job log files are written |
| `launchagent_prefix` | string | `com.tamtam` | Prefix for macOS LaunchAgent plist filenames |

### Notifications

Outbound webhook fired when the release pipeline reaches a terminal state. Supports Slack incoming webhooks, Discord webhooks, and any generic HTTP receiver (e.g. ntfy).

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `notification_webhook_url` | string | `''` | Destination URL; auto-detected as Slack / Discord / generic by URL pattern |
| `notification_webhook_secret` | string | `''` | If set, every POST includes an `X-TamTam-Signature` HMAC-SHA256 hex header over the JSON body |
| `notification_on_release_success` | boolean | `false` | Fire when the full release pipeline completes with exit 0 |
| `notification_on_release_fail` | boolean | `false` | Fire when any pipeline step fails and the pipeline halts |
| `notification_on_fix_loop_exhausted` | boolean | `false` | Fire when the fix-iteration cap (3/30 min) is reached without achieving LGTM |
| `notification_on_review_do_not_ship` | boolean | `false` | Fire when a review returns a DO NOT SHIP verdict |
| `notification_on_agent_run_fail` | boolean | `false` | Fire when any scheduled agent job exits non-zero |
| `notification_on_budget_blocked` | boolean | `false` | Fire when a run is refused because the Claude subscription budget threshold is exceeded (debounced once per window+resetsAt) |

### Subscription Budget

Live Claude Code subscription quota (5-hour rolling + 7-day weekly window) is fetched from `https://api.anthropic.com/api/oauth/usage` using the OAuth token from the macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) or `~/.claude/.credentials.json`. Snapshot is cached in-memory for 180 s. Surfaced live on `/stats` and Settings → Budget.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `budget_block_runs_enabled` | boolean | `false` | When true, pipeline routes (run, review, fix, push, release, rerun, fix-ci, agent run) return HTTP 409 once either window crosses `budget_block_at_pct` |
| `budget_block_at_pct` | number | `95` | Block threshold in percent (0–100). Applies to whichever window (5h or 7d) is hottest |
| `budget_warn_at_pct` | number | `80` | Cosmetic warn threshold; quota bars turn yellow at this percentage |

**Payload shape** (generic JSON POST):

```typescript
{
  event: 'release_success' | 'release_fail' | 'fix_loop_exhausted' | 'review_do_not_ship' | 'agent_run_fail';
  project: string;
  agent?: string;         // set for agent_run_fail events
  job_id: string;
  status: 'success' | 'failed';
  verdict?: string;       // set for review events
  cost_usd?: number;
  log_url?: string;       // link to /project/<name>/history; driven by TAMTAM_BASE_URL env
  message?: string;
  timestamp: number;      // ms since epoch
}
```

**Signature verification** (when `notification_webhook_secret` is set):

```js
const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
const isValid = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-tamtam-signature']));
```

**Adapter detection** (automatic, based on URL):

| URL pattern | Format |
|-------------|--------|
| `hooks.slack.com` | Slack Block Kit |
| `discord.com/api/webhooks` | Discord embed |
| anything else | Raw JSON (works for ntfy, custom receivers) |

**Retry**: 3 attempts, exponential backoff (1s → 2s → 4s). Failures are logged and never block pipeline progress.

**Test button**: Settings → Notifications tab → "Send Test" fires a synthetic `release_success` payload immediately.

### Templates

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `agent_templates` | string (JSON) | `''` | JSON array of `AgentTemplateRecord[]`; managed via the Templates tab in Settings |

`AgentTemplateRecord` shape:
```typescript
{
  name: string         // template identifier
  description: string
  model: string        // 'haiku' | 'sonnet' | 'opus'
  schedule: string     // '' (manual) | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '24h'
  runner: string       // 'pm2' | 'launchctl'
  prompt: string
  skillIds?: string[]
}
```

---

## API

**GET `/api/settings`** — returns `{ settings: Record<string, string> }` with all current pairs.

**PATCH `/api/settings`** — accepts a partial object; writes changed keys to DB, deletes null/empty values, invalidates cache. Only keys in `SETTING_KEYS` are accepted:

```
github_owner, claude_bin, log_dir, frequency, daytime, weekends,
launchagent_prefix, workspace_path, base_prompt, default_model,
permission_mode, commit_style, review_verdict_rules,
fix_ci_max_retries, fix_ci_retry_window_seconds, fix_ci_fast_crash_ms,
agent_templates,
log_retention_count, log_retention_days, job_row_retention_days,
notification_webhook_url, notification_webhook_secret,
notification_on_release_success, notification_on_release_fail,
notification_on_fix_loop_exhausted, notification_on_review_do_not_ship,
notification_on_agent_run_fail
```

**POST `/api/settings/test-notification`** — sends a test notification to verify webhook connectivity. Request body: `{ webhook_url: string, webhook_secret?: string }`. Response: `{ ok: boolean, error?: string }`.

---

## Per-project config (not in `settings` table)

These live on the `projects` table row, accessed via `GET/PATCH /api/projects/by-project/[name]/config`:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `testCommand` | string | `''` | Command run by the test step; auto-detected from `package.json`/`Makefile`/etc. if blank |
| `autoPushEnabled` | boolean | `false` | Enables pipeline chaining (test→review→fix→push) outside of a formal Release run |
| `testCronEnabled` | boolean | `false` | Scheduled test runs |
| `testCronSchedule` | string | `''` | Cron interval for scheduled tests |
| `customActions` | JSON | `[]` | Per-project buttons (name, command, color) shown in the UI |

---

## Quick Reference

### Common configuration scenarios

| Goal | Setting(s) to change |
|------|----------------------|
| Point to a different workspace | `workspace_path` |
| Use a different Claude binary | `claude_bin` |
| Make reviews more lenient | `review_verdict_rules` — soften NEEDS ATTENTION criteria |
| Use conventional commits | `commit_style` — already the default |
| Run agents 24/7 (not just nights) | `daytime = true` |
| Run agents on weekends | `weekends = on` |
| Disable fix-CI auto-retry | `fix_ci_max_retries = 0` |
| Faster polling after a run | Handled automatically by `startFastPolling()` in UI |

### Settings that take effect immediately vs on next run

| Immediate (no restart) | Next job only |
|-----------------------|---------------|
| `fix_ci_max_retries`, `fix_ci_retry_window_seconds`, `fix_ci_fast_crash_ms` | `base_prompt`, `commit_style`, `review_verdict_rules` (read at job start) |
| `workspace_path` (next projects scan) | `claude_bin`, `permission_mode` (read at job start) |

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Projects list empty | `workspace_path` not set or wrong path | Go to Settings → set workspace path |
| Claude not found | `claude_bin` path wrong | Verify with `which claude` and update the setting |
| Reviews always pass | `review_verdict_rules` too permissive | Tighten the rules in Settings → Behavior |
| fix-CI loops on a flaky test | `fix_ci_max_retries` too high | Lower to `1` or `0` to disable auto-retry |
| Agents run during the day unexpectedly | `daytime = true` | Set `daytime = false` for night-only |
