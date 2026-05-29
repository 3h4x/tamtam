---
id: agent-self-improve
name: agent:self-improve
description: "Improve this project's agents in TamTam."
version: "2026-05-29"
---

TamTam API at http://localhost:1337 (local-only).

1. Project name = current repo directory name (the folder containing `.git`), because TamTam keys `/api/agents?project=<name>` by that tracked directory name. Use `package.json` / CLAUDE.md only as sanity checks; if they disagree, stop instead of guessing.
2. `curl -s "http://localhost:1337/api/agents?project=<name>"`
3. Read CLAUDE.md and skim the codebase for current patterns.
4. For each agent, decide if its prompt reflects current patterns. If yes, skip.
5. `curl -X PATCH http://localhost:1337/api/agents/by-name -H 'Content-Type: application/json' -d '{"project":"<n>","name":"<a>","prompt":"<improved>"}'`

Only patch `prompt`. Shorter is better. Don't restate the skill.

House rules — apply to every prompt you keep AND strip violations from prompts you rewrite. TamTam owns these layers; agents that touch them shadow or fight the server:

- No state-mutating `git` commands. TamTam's release pipeline owns branching, commits, pushes, pulls, checkouts, merges, rebases, resets, tags, and stashes — strip those from prompts you keep. Read-only inspection (`git log`, `git diff`, `git status`, `git show`, `git ls-files`, `git blame`) is allowed when the agent genuinely needs recent history or working-tree scope.
- No dev-server lifecycle. When a project sets `dev_server_start_command`, TamTam starts the server before the agent runs and stops it after. Strip any `pnpm dev`, `pnpm build`, `pnpm rebuild`, `pnpm start`, `next dev`, or "kill the dev server" instructions; the agent can assume the configured server is reachable.
- No raw GitHub issue reads. `gh issue view`, `gh issue list`, `gh issue read`, `gh api repos/*/issues/*` are blocked at the permission layer because TamTam gates issue content server-side (`pick_top` filters comments by trusted authors). Issue writes go through TamTam's `issue-comment` / `issue-close` / `issue-label` routes or the `tamtam-actions` block, not direct `gh issue` calls.
