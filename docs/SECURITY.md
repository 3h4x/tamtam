# TamTam Security Model

## File-Agent Trust Model

### The Problem

`.tamtam/config.yml` and `.tamtam/agents/*.md` are committed files that control TamTam's behaviour for a project: which agents run on a schedule, which test command and custom actions are shared, which users are trusted, and which project-specific prompt guidance is injected.

When TamTam checks out a PR head branch (via any non-default-branch release or the "Work on" issue flow), the working tree switches to the attacker-controlled branch. Without protection, any file in `.tamtam/` would be silently honoured — allowing:

1. **New scheduled agents** — a PR adds `.tamtam/agents/pwn.md` with `schedule: 15m`, a malicious prompt, or a malicious `prerequisiteCommand`; TamTam registers and runs it automatically.
2. **Gate bypass** — `tests_disabled: true`, `review_disabled: true`, `auto_pr_merge_enabled: true` in `.tamtam/config.yml` lets the attacker's PR skip every safety check and self-merge.
3. **Trust escalation** — adding their own login to `safe_users` marks their content as trusted, enabling follow-on prompt injection via issue/PR bodies.
4. **Prompt steering** — changing `commits.commit_style` injects attacker-controlled guidance into generated commit-message prompts.

### The Defence: Default-Branch Pinning

`lib/tamtam-file-config.ts` and `lib/tamtam-file-agents.ts` detect the current branch at read time and, when on a **non-default branch**, read `.tamtam/` content from `origin/<defaultBranch>` via `git show` instead of the working tree.

#### How it works

```
On default branch (main/master):
  loadFileConfig(path) → reads .tamtam/config.yml from working tree  ✓

On feature/PR branch (fix/issue-42, attacker/pwn, …):
  loadFileConfig(path) → git show origin/main:.tamtam/config.yml     ✓
  scanFileAgents(path) → git ls-tree origin/main:.tamtam/agents/
                       + git show origin/main:.tamtam/agents/*.md     ✓
```

The working-tree files on the feature branch are **never read** for config or agent discovery. Only files that exist on the pinned default branch are used.

#### Fail-open on non-git directories

Branch detection (`lib/git-branch.ts`) catches all `execFileSync` errors and falls back to treating the working tree as "on the default branch" (`isDefaultBranch: true`). This means TamTam continues to work for projects that are not tracked with git — it just can't enforce branch pinning.

#### Writes still go to the working tree

`writeFileConfig` and `writeFileAgent` always write to the working tree regardless of branch. This is intentional: edits made via the Config UI on a feature branch will be staged as part of that branch's commit and take effect after merge to the default branch.

The Config tab shows a banner when the displayed config comes from the default branch rather than the current branch:

> Showing `main` config (you are on `fix/issue-42`); changes take effect after merge

### Protected Fields

The following fields are automatically protected by default-branch pinning:

| Field | Risk if bypassed |
|---|---|
| `safe_users` | Attacker marks themselves trusted; prompt injection via issue bodies |
| `test_command` | Verification command changed or weakened before release |
| `custom_actions` | New project-page buttons run attacker-chosen shell commands |
| `commit_style` | Commit-message generation prompt is steered by untrusted branch content |
| `auto_attach_docs` | Keyword→doc rules are read from the trusted default branch; the **content** of the referenced docs is also fetched from `origin/<defaultBranch>` (not the working tree) so a feature branch cannot rewrite an already-trusted doc and have it injected into terminal, agent, or review prompts |
| Any `.tamtam/agents/*.md` | New scheduled agent runs arbitrary prompts or committed prerequisite shell commands |

### Relationship to Other Defences

| Layer | What it does |
|---|---|
| **Default-branch pinning** (this doc) | Policy: only trust `.tamtam/` config from `origin/<default>` |
| **`<untrusted>` wrapping** (`lib/untrusted.ts`) | Wraps GitHub issue/PR text so Claude treats it as data, not instructions |
| **Sandbox** (issue #51) | Runtime: limits filesystem/network access of agent processes |

These layers are independent and complementary. Pinning stops the _registration_ of malicious agents; sandboxing limits what registered agents can do; untrusted wrapping stops prompt injection from issue/PR bodies.

For issue-driven automation, TamTam gates the full issue context server-side before the LLM sees anything. The default issue-cruncher prerequisite calls `GET /api/projects/by-project/[project]/issues?pick_top=1`, which:

1. Filters open issues to authors trusted by the union of global `trusted_github_users` and per-project `.tamtam/config.yml` `security.safe_users`.
2. Drops issues with blocker labels (`blocked`, `needs-info`, `needs-design`, `discussion`, `question`, `wontfix`, `duplicate`) or already-assigned issues.
3. Ranks by priority labels (`critical`/`urgent`/`p0` > `high`/`p1` > `bug` > `enhancement`/`feature`/`p2` > everything else; `good first issue` gets a small bonus) and breaks ties by `updatedAt` desc.
4. Fetches the top pick's body and comments via `gh issue view`, then **drops every comment whose author is not in the trust allowlist** — untrusted comments never enter the response, the cache, or the agent prompt. Dropped comments are counted (`droppedCommentCount`) as an audit signal but their bodies are not surfaced.

The issue-cruncher skill prompt forbids the agent from calling `gh issue view`, `gh issue list`, `gh issue read`, or `gh api repos/*/issues/*` directly — those are the read paths that bring raw external text into context. The run command also passes Claude `--disallowed-tools` rules for `gh issue:*` and the issue-reading `gh api` paths as defense-in-depth. Issue write actions use TamTam's `issue-comment`, `issue-close`, and `issue-label` API routes instead of direct `gh issue` commands so repo resolution, allowed input shape, and cache invalidation stay server-side. This is "drop > wrap": when filtering at the source is feasible, untrusted content never reaches the LLM, which is strictly stronger than wrapping it in `<untrusted>` and relying on the model to honor the system preamble (the wrap pattern stays in use for PR-review flows where the diff itself is the work). Drop-at-source is implemented in `app/api/projects/by-project/[projectName]/issues/route.ts` (`handlePickTop` + `filterTrustedComments`).

## Log Redaction

TamTam redacts common credential shapes before job output is persisted to log files and before log content is returned by browser-facing log APIs, including SSE streaming and the project log viewer. The redaction layer covers GitHub tokens, OpenAI/Anthropic-style API keys, bearer tokens, key/value credential assignments, basic-auth URLs, Slack webhook URLs, Discord webhook URLs, and environment values whose variable names look credential-bearing. Prerequisite command strings are redacted anywhere they are persisted or forwarded alongside prerequisite output.

This is a defensive last-mile filter, not a complete secret-management system. It cannot guarantee redaction for every proprietary token format, binary output, or a secret split across unusual stream chunk boundaries. Do not intentionally print secrets from custom actions, prerequisite commands, provider shims, or project test commands; prefer passing credentials through the environment and keeping command output credential-free.

## Dependency & Supply-Chain Hygiene

- **Lock file**: always commit `pnpm-lock.yaml`. Never bypass `--frozen-lockfile` or use `--no-lockfile`. Use `pnpm` for all manifest/lockfile changes — `npm install`, `yarn add`, or any other PM that can desync `pnpm-lock.yaml` are forbidden.
- **Install scripts**: inspect `postinstall`, `prepare`, `preinstall`, `install` scripts before adding or updating any dependency. Treat them as arbitrary code execution.
- **Allowed build scripts**: `package.json` pins `pnpm.onlyBuiltDependencies` to `[esbuild, sharp, unrs-resolver]`, and `pnpm-workspace.yaml` pins the explicit build allow/deny list. Puppeteer's install script is denied, so tools that need Chrome/Chromium must use an existing system browser or a committed fallback artifact. Do not add allowed build scripts without explicit user approval.
- **No silent additions**: every new dependency requires user approval and a justification in the commit message. Prefer packages with > 1M weekly downloads and > 1 year history. Inspect the npm registry entry for maintainer continuity — sudden ownership flips, very-recent first publishes, or thin version history are blockers unless the user explicitly accepts the risk.
- **Audit after changes**: run `pnpm audit` after any `pnpm add`/`pnpm remove`/`pnpm up`/`pnpm update`/`pnpm dedupe` or manual lockfile refresh. Fix or document high-severity findings before committing.
- **Never bypass git hooks**: do not pass `--no-verify` to `git commit`. If a pre-push hook fails, fix the root cause.
- **No secrets in code**: env vars only; never commit `.env` or hardcoded tokens.

## Destructive Operations

- **Destructive git**: do not run `git reset --hard`, `git clean`, force pushes, branch deletion, or history rewrites without explicit request.
- **Dirty worktrees are normal**: before editing, check whether the target file has local changes. Preserve unrelated edits; never revert someone else's in-progress work to get a clean diff.
- **Production data**: do not drop tables, run destructive SQL against the live `DATABASE_URL` Postgres, or remove project log directories without explicit approval. Migrations must be additive or carefully backfilled.
- **External side effects**: `git push`, GitHub issue/PR actions, webhook sends, and PM2 process changes are real side effects. Run only when required by the task and the target is clear.
- **Never SIGKILL low PIDs**: `lib/jobs/lifecycle.ts` uses `pgrep -P <job.pid>` + `process.kill(child, 'SIGKILL')` to clean up hung Claude CLI trees. PIDs ≤ `SAFE_PID_FLOOR` (100) are refused — PID 1 on macOS is `launchd`, parent of Finder, Dock, the terminal, and every user GUI app. A bad `job.pid` without this guard would SIGKILL every user-owned process. Any future code that takes a pid from job/DB state and calls `process.kill` MUST gate on `pid > SAFE_PID_FLOOR` and bail with `console.warn` otherwise. In tests, always use a high synthetic PID like `99999` — never a real or low PID.

### Implementation Files

- `lib/git-branch.ts` — synchronous git helpers (`getBranchContext`, `gitShowSync`, `gitLsTreeSync`)
- `lib/tamtam-file-config.ts` — `loadFileConfig` (branch-aware), `writeFileConfig`
- `lib/tamtam-file-agents.ts` — `scanFileAgents`, `loadFileAgent` (both branch-aware)
- `lib/skills/auto-attach-docs.ts` — `resolveAutoAttachedDocs` (branch-aware: reads doc content via `gitShowSync` on non-default branches to match the trust ref used by `loadFileConfig`)
- `lib/shared/log-redaction.ts` — shared log redaction patterns and environment-value masking
- `__tests__/lib/tamtam-file-config-branch.test.ts` — unit tests for config branch-pinning
- `__tests__/lib/tamtam-file-agents-branch.test.ts` — unit tests for agent branch-pinning
