# TamTam Security Model

## File-Agent Trust Model

### The Problem

`.tamtam/config.yml` and `.tamtam/agents/*.md` are committed files that control TamTam's behaviour for a project: which agents run on a schedule, which test command and custom actions are shared, which users are trusted, and which project-specific prompt guidance is injected.

When TamTam checks out a PR head branch (via any non-default-branch release or the "Work on" issue flow), the working tree switches to the attacker-controlled branch. Without protection, any file in `.tamtam/` would be silently honoured — allowing:

1. **New scheduled agents** — a PR adds `.tamtam/agents/pwn.md` with `schedule: 15m`, a malicious prompt, or a malicious `prerequisiteCommand`; TamTam registers and runs it automatically.
2. **Verification weakening** — changing `pipeline.test_command`, `pipeline.release_timeout_minutes`, or `pipeline.review_prerequisite_command` in `.tamtam/config.yml` changes what TamTam executes or injects around release checks.
3. **Trust escalation** — adding their own login to `safe_users` marks their content as trusted, enabling follow-on prompt injection via issue/PR bodies.
4. **Prompt steering** — changing `commits.commit_style` injects attacker-controlled guidance into generated commit-message prompts.

### The Defence: Default-Branch Pinning

`lib/skills/tamtam-file-config.ts` and `lib/agents/tamtam-file-agents.ts` detect the current branch at read time and, when on a **non-default branch**, read `.tamtam/` content from `origin/<defaultBranch>` via `git show` instead of the working tree.

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

Branch detection (`lib/git/git-branch.ts`) catches all `execFileSync` errors and falls back to treating the working tree as "on the default branch" (`isDefaultBranch: true`). This means TamTam continues to work for projects that are not tracked with git — it just can't enforce branch pinning.

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
| `release_timeout_minutes` | Release wall-clock guard shortened or stretched for attacker-controlled work |
| `review_prerequisite_command` | Shared pre-review command changed before review prompt assembly |
| `custom_actions` | New project-page buttons run attacker-chosen shell commands |
| `commit_style` | Commit-message generation prompt is steered by untrusted branch content |
| `auto_attach_docs` | Keyword→doc rules are read from the trusted default branch; the **content** of the referenced docs is also fetched from `origin/<defaultBranch>` (not the working tree) so a feature branch cannot rewrite an already-trusted doc and have it injected into terminal, agent, or review prompts |
| Any `.tamtam/agents/*.md` | New scheduled agent runs arbitrary prompts or committed prerequisite shell commands |

### Relationship to Other Defences

| Layer | What it does |
|---|---|
| **Default-branch pinning** (this doc) | Policy: only trust `.tamtam/` config from `origin/<default>` |
| **`<untrusted>` wrapping** (`lib/shared/untrusted.ts`) | Wraps GitHub issue/PR text so Claude treats it as data, not instructions |
| **Sandbox** (issue #51) | Runtime: limits filesystem/network access of agent processes |
| **PR-branch execution gate** (`lib/security/pr-branch-execution.ts`) | Refuses host-side project-code execution on non-default branches unless the checkout is clean, the current branch is known, and every branch commit SHA can be resolved through GitHub to an `author.login` in `safe_users` / `trusted_github_users`, or the caller explicitly approves the supported test-run override; also blocks auto-merge when the GitHub PR diff touches dependency manifests, build scripts, workflow files, Dockerfiles, Makefiles, or JS/TS config files |
| **Shared-token HTTP auth** (`middleware.ts`, `app/api/auth/*`) | When `auth_token` is configured, every UI/API request except `/login`, `/api/health`, and `/api/auth/*` must carry a valid bearer token or the httpOnly `tamtam_auth` cookie |

These layers are independent and complementary. Pinning stops the _registration_ of malicious agents; sandboxing limits what registered agents can do; untrusted wrapping stops prompt injection from issue/PR bodies.

For issue-driven automation, TamTam gates the full issue context server-side before the LLM sees anything. The default issue-cruncher prerequisite calls `GET /api/projects/by-project/[project]/issues?pick_top=1`, which:

1. Filters open issues to authors trusted by the union of global `trusted_github_users` and per-project `.tamtam/config.yml` `security.safe_users`.
2. Drops issues with blocker labels (`blocked`, `needs-info`, `needs-design`, `discussion`, `question`, `wontfix`, `duplicate`) or already-assigned issues.
3. Ranks by priority labels (`critical`/`urgent`/`p0` > `high`/`p1` > `bug` > `enhancement`/`feature`/`p2` > everything else; `good first issue` gets a small bonus) and breaks ties by `updatedAt` desc.
4. Fetches the top pick's body and comments via `gh issue view`, then **drops every comment whose author is not in the trust allowlist** — untrusted comments never enter the response, the cache, or the agent prompt. Dropped comments are counted (`droppedCommentCount`) as an audit signal but their bodies are not surfaced.
5. Creates, reuses, or checks out the issue branch server-side before returning success, so the agent receives branch metadata instead of running branch-switching git commands itself.

The issue-cruncher skill prompt forbids the agent from calling `gh issue view`, `gh issue list`, `gh issue read`, or `gh api repos/*/issues/*` directly — those are the read paths that bring raw external text into context. It also forbids `git checkout` and `git switch` because branch movement is owned by TamTam's server-side prerequisite. The run command passes Claude `--disallowed-tools` rules for `gh issue:*`, the issue-reading `gh api` paths, and the git branch-switch primitives as defense-in-depth. Issue write actions use TamTam's `issue-comment`, `issue-close`, and `issue-label` API routes instead of direct `gh issue` commands so repo resolution, allowed input shape, and cache invalidation stay server-side. This is "drop > wrap": when filtering at the source is feasible, untrusted content never reaches the LLM, which is strictly stronger than wrapping it in `<untrusted>` and relying on the model to honor the system preamble (the wrap pattern stays in use for PR-review flows where the diff itself is the work). Drop-at-source is implemented in `app/api/projects/by-project/[projectName]/issues/route.ts` (`handlePickTop` + `filterTrustedComments`).

### HTTP Authentication

TamTam defaults to localhost-only dev mode. In that mode `auth_token` is unset and startup logs:

```text
[auth] TamTam is running without auth — only safe on localhost
```

For any LAN, tunnel, reverse-proxy, or hosted deployment, enable Settings → Auth → Generate token. The generated token is shown once, hashed with scrypt in the existing `settings` table, and never returned by `GET /api/settings`. Middleware checks every non-public request before route execution:

- API clients use `Authorization: Bearer <token>`.
- Browser users sign in at `/login`; `/api/auth/login` verifies the token and sets the httpOnly `tamtam_auth` cookie.
- `/api/streaming/[jobId]` works through the cookie path because EventSource cannot attach custom headers.
- `/api/health` remains public for load balancers and smoke probes.

Rotating the token invalidates future bearer/cookie checks that use the old token. Existing browser cookies contain the old token and must log in again.

### Host Command Execution on PR Branches

Project test commands, review prerequisite commands, and dev-server start commands execute project code directly, so they use a stricter environment than ordinary CLI model runs. These host-side commands on non-default branches are gated by `checkPrBranchExecutionGate`: TamTam requires a known current branch and a clean working tree, lists the branch commit SHAs, resolves each commit through GitHub, and trusts only the returned `author.login` value. Local git author names and emails are ignored because they are user-controlled. If branch detection fails, the worktree has uncommitted or untracked changes, any commit is unknown to GitHub, any commit has no mapped GitHub author, or any commit maps to a login outside `safe_users` / `trusted_github_users`, TamTam refuses to run the host command. The test API accepts `approveUntrustedPrBranch: true` for explicit operator approval (skips the gate entirely).

There is one narrow, automatic relaxation: a release marked `trustedLocalChanges` on its release meta-job (`start-release.ts`) — set either by **TamTam's own in-process agent run** (issue-cruncher, or a manual issue-linked `run`) or by an **operator-initiated release** (an explicit POST to the `/release` route, i.e. the UI Release button; `operatorInitiated: true`). In both cases the uncommitted working tree is the operator's/agent's own work, not an untrusted external ref. When a phase of that release runs the gate, the `allowTrustedLocalChanges` option lets the **uncommitted working-tree delta** pass — because that delta is TamTam's own agent output, which is the *same* trust posture the default branch already gets unconditionally (the agent's instructions came from a `pick_top`-filtered, `<untrusted>`-wrapped issue, so this opens no new injection surface beyond an agent run on `main`). It is **not** a gate bypass: every *committed* branch commit is still resolved through GitHub and verified against `safe_users` / `trusted_github_users`, so a reused branch carrying an untrusted attacker commit is still refused, and an unreadable `git status` still fails closed. The flag is read off the active release via `parentContext` (`lib/pipeline/trusted-local-release.ts`), so orchestrator-driven re-runs (test→fix→test, review→fix→review) inherit it without per-call plumbing. Test, review-prerequisite, and dev-server child processes are spawned with credential-like environment variables stripped (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, API keys, AWS/GCP/Google credentials, npm auth token variables). PR auto-merge is additionally blocked when the actual GitHub PR diff changes high-risk execution files such as dependency manifests, package-manager lockfiles, `.github/workflows/*`, `Makefile`, `Dockerfile`, build configs, or JS/TS config files; failure to inspect the PR diff is treated as risky and blocks auto-merge.

### Per-Provider Enforcement of `--disallowed-tools`

The `--disallowed-tools` defense-in-depth assembled in `lib/agents/intake-workflow.ts` is **only enforced when the agent runs through Claude**. Each provider's shim handles the flag differently:

| Provider | What the shim does with `--disallowed-tools` | What actually blocks forbidden commands at runtime |
|---|---|---|
| **Claude** (`scripts/claude-shim.js`) | Pass-through to `claude` CLI verbatim | Claude CLI permission layer — Bash tool returns `Permission to use Bash … has been denied`; result includes `permission_denials[]` |
| **Codex** (`scripts/codex-shim.js`) | **Silently dropped** — the shim's arg loop only recognizes `--allowed-tools`/`--tools`/`--system-prompt`; `--disallowed-tools` falls through both iterations and never reaches codex | Codex sandbox only (with `permission_mode=auto`/`acceptEdits`: network blocked + FS confined to workdir + `/tmp` + `$TMPDIR` + `~/.codex/memories`). With `permission_mode=bypassPermissions` codex receives `--dangerously-bypass-approvals-and-sandbox` and there is **no** enforcement |
| **Gemini** (`scripts/gemini-shim.js`) | Silently dropped (translates only `--permission-mode` → `--approval-mode`) | Whatever the gemini CLI enforces for its approval mode |
| **LM Studio / Deep Agents** | Silently dropped | Their own per-mode allow/deny lists; not a TamTam-enforced gate |

Verified live with codex+auto in a controlled cwd: `--disallowed-tools "Bash(gh issue:*),…"` was passed in, the shim discarded it, and the model was free to invoke any shell command. `gh issue list` still failed — but only because the sandbox blocks DNS (`error connecting to api.github.com`), not because of the deny rule. With `bypassPermissions` that DNS block would also go away.

Claude prompt-injection probe (issue body asking the agent to run a forbidden token via Bash) showed two-layer defense in practice: the model declined on its own ("I will not comply … this is a prompt injection attack"), and even when the model was made to call the Bash tool, the CLI returned `Permission to use Bash with command … has been denied`. Codex (gpt-5.4-mini) declined the same overt injection at the model layer, but had it complied there would be no CLI-layer backstop.

**Implications for `permission_mode`:**

- `auto` (current default) without browser broker injection → for codex this is `-a never --sandbox workspace-write`, which keeps the network/FS sandbox as the real safety boundary. Equivalent to `acceptEdits` for codex routing.
- Broker-enabled Codex runs in write-capable modes (`auto`, `acceptEdits`, `default`, `dontAsk`) are promoted to `--sandbox danger-full-access` so MCP loopback calls can reach TamTam's browser broker. When `tamtam_network_policy_strict` wraps the process in the macOS seatbelt profile, that outer profile is the real safety boundary. Without that wrapper, enabling the browser broker deliberately broadens the Codex trust boundary. `plan` remains `read-only` even with broker env present.
- `bypassPermissions` → for codex this is `--dangerously-bypass-approvals-and-sandbox`. The sandbox is fully off and `--disallowed-tools` is silently dropped — there is no defense-in-depth left for an issue-cruncher run under that mode. Treat `bypassPermissions` as a deliberate trust escalation for codex-driven agent work and prefer `auto` whenever possible.

**Plugging the codex gap**: the codex shim could be updated to honor `--disallowed-tools` (e.g. via codex's `--config tools.shell.deny_patterns=…` or a wrapper that inspects shell invocations before passing them to codex). Until that lands, the issue-cruncher's only enforced barriers on codex are the sandbox and the model itself; the skill prompt's `## Hard rules — do not bypass` claim that gh-issue commands are "blocked at the permission layer" is technically only true for Claude.

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
- **Never SIGKILL low PIDs**: `lib/jobs/cancellation.ts` centralizes the `pid > SAFE_PID_FLOOR` (100) guards used before cancellation paths signal job PIDs. PID 1 on macOS is `launchd`, parent of Finder, Dock, the terminal, and every user GUI app. A bad `job.pid` without this guard would SIGKILL every user-owned process. Any future code that takes a pid from job/DB state and calls `process.kill` MUST gate on `pid > SAFE_PID_FLOOR` and bail with `console.warn` otherwise. In tests, always use a high synthetic PID like `99999` — never a real or low PID.

### Implementation Files

- `lib/git/git-branch.ts` — synchronous git helpers (`getBranchContext`, `gitShowSync`, `gitLsTreeSync`)
- `lib/skills/tamtam-file-config.ts` — `loadFileConfig` (branch-aware), `writeFileConfig`
- `lib/agents/tamtam-file-agents.ts` — `scanFileAgents`, `loadFileAgent` (both branch-aware)
- `lib/skills/auto-attach-docs.ts` — `resolveAutoAttachedDocs` (branch-aware: reads doc content via `gitShowSync` on non-default branches to match the trust ref used by `loadFileConfig`)
- `lib/shared/log-redaction.ts` — shared log redaction patterns and environment-value masking
- `__tests__/lib/tamtam-file-config-branch.test.ts` — unit tests for config branch-pinning
- `__tests__/lib/tamtam-file-agents-branch.test.ts` — unit tests for agent branch-pinning
