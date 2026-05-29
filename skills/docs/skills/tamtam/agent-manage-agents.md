---
id: agent-manage-agents
name: agent:manage-agents
description: "CRUD agents in TamTam to match project needs."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  tier: featured
  fallbackEnabled: true
---

TamTam API at http://localhost:1337 (local-only).

Gather: CLAUDE.md, project name from the current repo directory name (the folder containing `.git`), and current activity by skimming the codebase. Use `package.json` / `pyproject.toml` / CLAUDE.md only as sanity checks; if they disagree with the repo directory name, stop instead of guessing.
Fetch: `curl -s "http://localhost:1337/api/agents?project=<name>"` — fields: id, name, prompt, skillIds, model, schedule, enabled.

Decide changes: missing test agent? stale agents referencing dead paths? duplicate purpose? missing schedule? Don't create for hypothetical needs.

Create: `POST /api/agents` with `{project, name, prompt, skillIds: [], model, schedule, enabled: true}`. Prefer semantic tiers: fast for cheap tasks, normal for the default, smart only for hard reasoning. Legacy haiku/sonnet/opus aliases still resolve.
Update: `PATCH /api/agents/by-name` (`prompt` only unless asked).
Delete: `DELETE /api/agents/<id>` only when stale/broken.

Report: created, updated, deleted, no-change. Filter strictly by this project. Keep prompts 3–8 sentences.

House rules — apply to every prompt you author AND strip violations from prompts you rewrite. TamTam owns these layers; agents that touch them shadow or fight the server:

- No state-mutating `git` commands. TamTam's release pipeline owns branching, commits, pushes, pulls, checkouts, merges, rebases, resets, tags, and stashes — strip those from prompts you keep. Read-only inspection (`git log`, `git diff`, `git status`, `git show`, `git ls-files`, `git blame`) is allowed when the agent genuinely needs recent history or working-tree scope.
- No dev-server lifecycle. When a project sets `dev_server_start_command`, TamTam starts the server before the agent runs and stops it after. Strip any `pnpm dev`, `pnpm build`, `pnpm rebuild`, `pnpm start`, `next dev`, or "kill the dev server" instructions; the agent can assume the configured server is reachable.
- No raw GitHub issue reads. `gh issue view`, `gh issue list`, `gh issue read`, `gh api repos/*/issues/*` are blocked at the permission layer because TamTam gates issue content server-side (`pick_top` filters comments by trusted authors). Issue writes go through TamTam's `issue-comment` / `issue-close` / `issue-label` routes or the `tamtam-actions` block, not direct `gh issue` calls.
