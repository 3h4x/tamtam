# `.tamtam/` Directory (per-project, committed to version control)

Each tracked workspace project can have a `.tamtam/` directory in its root for version-controlled TamTam config. TamTam reads these files on every request; writes from the UI are saved back automatically.

On a feature/PR branch, config is read from `origin/<defaultBranch>` (not the working tree) to prevent privilege escalation from untrusted branches.

## `.tamtam/config.yml`

The team contract — committed and shared. Shared-by-all settings only. All fields optional.

```yaml
pipeline:
  test_command: pnpm test         # overrides auto-detected command

actions:
  custom_actions:                 # buttons shown on the project page
    - name: Deploy
      command: pnpm deploy
      color: green

security:
  safe_users:                     # GitHub logins whose PR comments are not wrapped as untrusted
    - octocat

commits:
  commit_style: |                 # per-project commit voice; overrides global commit_style
    Conventional commits, imperative mood, subject under 72 chars, no trailing period.

docs:
  auto_attach_docs:               # word-boundary keyword → project doc; injected on first invocation of a session
    - keywords: [test, tests, vitest, playwright]
      doc: docs/TEST.md
    - keywords: [deploy, release, pipeline]
      doc: docs/PIPELINE.md
```

Supported keys: `test_command`, `release_timeout_minutes`, `review_prerequisite_command`, `custom_actions`, `safe_users`, `commit_style`, `auto_attach_docs`.

**Workflow flags** (`auto_commit_enabled`, `auto_push_enabled`, `auto_pr_merge_enabled`, `release_after_run`, `test_cron_enabled`, `test_cron_schedule`, `tests_disabled`, `review_disabled`, `issue_auto_branch`) are **DB-only** — each developer opts in individually. Older `.tamtam/config.yml` files may still contain those keys; TamTam migrates them to the DB on startup and ignores them on subsequent reads.

**Local review prompt controls** (`review_prompt_addendum`, `fix_prompt_addendum`) are DB-only. `pipeline.review_prerequisite_command` may be committed when the project has a shared pre-review codegen/schema command; otherwise the Config tab's DB value is used as the local fallback.

Reader: `lib/skills/tamtam-file-config.ts` → `loadFileConfig(projectPath)` / `writeFileConfig(projectPath, updates)`. The Config tab shows a banner listing which keys come from the file; saving writes back.

`auto_attach_docs` is enforced by `lib/skills/auto-attach-docs.ts` and wired into three "first-invocation" entry points:
1. Terminal run route (`app/api/projects/by-project/[projectName]/run/route.ts`, gated on `!resumeSessionId`).
2. Pipeline review step (`lib/pipeline/start-review.ts`, matching against the review scope).
3. Agent intake (`lib/agents/intake-workflow.ts`, matching against the task prompt).

Because pipeline phases share a CLI session via `--resume`, the attached doc carries through fix/commit/push without re-attachment within one review cycle. A new `review` job (e.g. after a fix loop) opens a fresh session and re-attaches.

Each match records the attached doc paths under `contextMeta.autoAttachedDocs` for trace visibility.

## `.tamtam/agents/*.md`

Each `.md` file defines one agent scoped to the project. Filename (minus `.md`) is the agent name. YAML frontmatter sets default metadata; body is the prompt.

```markdown
---
provider: codex        # optional: claude | codex | gemini | lmstudio
model: normal          # fast | normal | smart (legacy haiku | sonnet | opus still read)
schedule: 4h           # optional: 15m 30m 1h 2h 4h 8h 12h 24h
skillIds: ["agent-tests"]   # JSON array or space-separated skill IDs
runner: pm2            # pm2 | launchctl (launchctl deprecated)
enabled: true
---

Prompt content here. Sent verbatim as the agent's task instructions.
```

File agents appear in the Agents tab with a `file` badge. Prompt edits are written back to `.tamtam/agents/<name>.md`; committed frontmatter such as `provider` is preserved on write. Operational settings (`enabled`, `schedule`, `model`, `runner`, `skillIds`) are stored as DB overrides under `agent_override:<project>:<name>` so UI toggles do not dirty tracked files.

A DB agent with the same project+name takes precedence over the file agent.

Reader: `lib/agents/tamtam-file-agents.ts` → `scanFileAgents(projectPath, projectName)` / `loadFileAgent(...)`. File agent IDs use the format `file:<project>:<name>` and are handled transparently in all agent API routes.
