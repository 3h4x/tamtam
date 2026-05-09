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
| Any `.tamtam/agents/*.md` | New scheduled agent runs arbitrary prompts or committed prerequisite shell commands |

### Relationship to Other Defences

| Layer | What it does |
|---|---|
| **Default-branch pinning** (this doc) | Policy: only trust `.tamtam/` config from `origin/<default>` |
| **`<untrusted>` wrapping** (`lib/untrusted.ts`) | Wraps GitHub issue/PR text so Claude treats it as data, not instructions |
| **Sandbox** (issue #51) | Runtime: limits filesystem/network access of agent processes |

These layers are independent and complementary. Pinning stops the _registration_ of malicious agents; sandboxing limits what registered agents can do; untrusted wrapping stops prompt injection from issue/PR bodies.

For issue-driven automation, TamTam now also gates issue selection before the LLM sees issue bodies: `GET /api/projects/by-project/[project]/issues?trusted_only=1` filters server-side to authors trusted by the union of global `trusted_github_users` and per-project `.tamtam/config.yml` `security.safe_users`. The default issue-cruncher agent consumes that trusted-only prerequisite output and must not call `gh issue list` directly.

### Implementation Files

- `lib/git-branch.ts` — synchronous git helpers (`getBranchContext`, `gitShowSync`, `gitLsTreeSync`)
- `lib/tamtam-file-config.ts` — `loadFileConfig` (branch-aware), `writeFileConfig`
- `lib/tamtam-file-agents.ts` — `scanFileAgents`, `loadFileAgent` (both branch-aware)
- `__tests__/lib/tamtam-file-config-branch.test.ts` — unit tests for config branch-pinning
- `__tests__/lib/tamtam-file-agents-branch.test.ts` — unit tests for agent branch-pinning
