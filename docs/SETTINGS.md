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
log_retention_count, log_retention_days, job_row_retention_days
```

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
