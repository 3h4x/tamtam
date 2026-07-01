# `.tamtam/` Directory (per-project, committed to version control)

Each tracked workspace project can have a `.tamtam/` directory in its root for version-controlled TamTam config. TamTam reads these files on every request; selected team-contract UI edits are saved back automatically, while local/operator controls stay DB-only.

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

**Local review prompt controls** (`review_prompt_addendum`, `fix_prompt_addendum`) are DB-only. `pipeline.review_prerequisite_command` may be committed when the project has a shared pre-review codegen/schema command; otherwise the Config tab's DB value is used as the local fallback. Config-tab edits to `review_prerequisite_command` update that DB fallback, not `.tamtam/config.yml`.

Reader: `lib/skills/tamtam-file-config.ts` → `loadFileConfig(projectPath)` / `writeFileConfig(projectPath, updates)`. The Config tab shows a banner listing which keys come from the file; saving writes back for `test_command`, `release_timeout_minutes`, and `commit_style`. Custom action edits also mirror `custom_actions` to the file.

`auto_attach_docs` is enforced by `lib/skills/auto-attach-docs.ts` and wired into three "first-invocation" entry points:
1. Terminal run route (`app/api/projects/by-project/[projectName]/run/route.ts`, gated on `!resumeSessionId`).
2. Pipeline review step (`lib/pipeline/start-review.ts`, matching against the review scope).
3. Agent intake (`lib/agents/intake-workflow.ts`, matching against the task prompt).

Because pipeline phases share a CLI session via `--resume`, the attached doc carries through fix/commit/push without re-attachment within one review cycle. A new `review` job (e.g. after a fix loop) opens a fresh session and re-attaches.

Each match records the attached doc paths under `contextMeta.autoAttachedDocs` for trace visibility.

## Agents are DB-only

Agents are **not** sourced from repo files. There is no `.tamtam/agents/` directory and no file-based agent definition. All agents live in the `agents` DB table and are created, edited, renamed, and deleted only through the authenticated app (API/UI); every agent ID is `agent-<ts>`. Because agent definitions never come from committed files, a PR cannot introduce or alter an agent. (File-based **skills/personas** under `skills/docs/skills/` are a separate feature and still exist — see `docs/AGENT.md`.)

## `.tamtam/cache/` (per-project, **not** committed)

Local-only scratch space inside the project worktree. Writers include the agent memory system (`lib/agents/agent-memory.ts`), which stores the "remember this for next run" file at `.tamtam/cache/agent-memory/<agentName>.md`, and the improve-agent audit artifacts under `.tamtam/cache/audits/`. The directory lives inside the worktree (rather than a global `~/.cache/tamtam/...` path) so codex-sandboxed agents — whose writable roots are limited to the workspace — can rewrite their own local cache files at the end of a run.

`ensureAgentMemoryDir(projPath)` also writes `.tamtam/.gitignore` with `cache/` on first use. That ignore file is committed (it's the only sensible way to give every project the rule without editing each repo's root `.gitignore`); the cache contents themselves stay local.
