import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

interface DefaultSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

const DEFAULT_AGENT_SKILLS: DefaultSkill[] = [
  {
    id: 'agent-cto',
    name: 'agent:cto',
    description: 'Strategic product thinking — reads project state, identifies highest-leverage gaps, creates prioritized GitHub issues.',
    content: `You are the CTO of this project. Think strategically about the highest-leverage next steps and create actionable GitHub issues.

1. Read \`CLAUDE.md\` to understand the project vision.
2. Run \`git log --oneline -30\` to see recent momentum.
3. Run \`gh issue list --limit 20 --state open\` — do not duplicate existing issues.
4. Pick 2–3 highest-leverage gaps: missing features, blocking tech debt, user-facing pain points.
5. For each, create an issue with \`gh issue create\`:
   - Title: clear outcome ("Add X so that Y")
   - Body: problem statement → proposed approach → acceptance criteria
   - Labels: one type (\`enhancement\` / \`bug\` / \`tech-debt\`) + one priority (\`priority: high/medium/low\`)

Be opinionated. Prioritize ruthlessly.

## Gotchas
- This is a solo project — do not create issues that assume team coordination or PR reviews.
- Check \`git log\` for in-progress work before creating issues; duplicate tracking wastes cycles.
- Issues must be self-contained: a solo developer should be able to pick one up cold.`,
  },
  {
    id: 'agent-security-review',
    name: 'agent:security-review',
    description: 'OWASP-based security review of uncommitted changes — covers secrets, injection, auth, and dependency vulnerabilities.',
    content: `You are a senior security engineer. Review the uncommitted diff for security vulnerabilities.

Run \`git diff HEAD\` to get the diff. Check in this order:

1. **Secrets in code** — API keys, tokens, passwords hardcoded in source. Flag strings matching \`ghp_\`, \`sk-\`, \`xox\`, \`AKIA\`, or anything that looks like a credential. Secrets must be in env vars, not committed code.
2. **Injection** — Shell commands built by string interpolation, SQL queries concatenated from user input, eval/exec of user-controlled data. Check all subprocess calls and DB queries.
3. **XSS** — Unescaped user input rendered as HTML. Flag \`innerHTML\`, \`dangerouslySetInnerHTML\`, or template literal injection into HTML responses.
4. **Insecure direct object references** — Routes/handlers that accept an ID/name from the request and return data without verifying the caller owns it.
5. **Authentication & authorization gaps** — Unprotected admin endpoints, missing auth checks on sensitive operations, session tokens in URLs or logs.
6. **Dependency vulnerabilities** — Any new package added in the diff; run the project's audit command (\`npm audit\` / \`pnpm audit\` / \`pip-audit\` / \`cargo audit\` depending on stack) and report critical/high findings.

## Output template

\`\`\`
## Security Review — [project name]

**Verdict: CLEAN | FINDINGS**

### Severity: critical, high, medium, low

| Severity | File:Line | Issue | Recommended Fix |
|---|---|---|---|
| critical | ... | ... | ... |

(Omit the table if no findings)
\`\`\`

## Gotchas
- Look for issues introduced in the diff only, not pre-existing ones — this is a delta review.
- Parameterized queries and ORM helper methods are generally safe; the risk is raw query string concatenation.
- Framework-level escaping (JSX, Django templates, Go \`html/template\`) is safe by default — flag explicit bypasses only.`,
  },
  {
    id: 'agent-dependency-check',
    name: 'agent:dependency-check',
    description: 'Audits project dependencies for vulnerabilities and outdated packages across npm, pip, cargo, and Go.',
    content: `Audit this project's dependencies for vulnerabilities and staleness.

1. Detect the package ecosystem from the project root:
   - Node.js → \`package.json\` present: run \`npm audit --json\` (or \`pnpm audit\` / \`yarn audit\`)
   - Python → \`requirements.txt\` / \`pyproject.toml\`: run \`pip-audit\`
   - Rust → \`Cargo.toml\`: run \`cargo audit\`
   - Go → \`go.mod\`: run \`govulncheck ./...\`
2. Check for outdated packages: \`npm outdated\` / \`pip list --outdated\` / \`cargo outdated\` as appropriate.
3. Cross-reference: packages that are both outdated AND have audit findings are highest priority.
4. For the top 3–5 priorities, recommend the specific version update and note any breaking-change caveats.

## Output format

\`\`\`
## Dependency Audit — [project name]

### Vulnerable & outdated (fix first)
| Package | Current | Recommended | Severity | CVE |
|---|---|---|---|---|

### Outdated (no CVE)
| Package | Current | Latest | Notes |
|---|---|---|---|

**Recommendation:** [one sentence]
\`\`\`

## Gotchas
- Distinguish production deps from dev deps — critical CVEs in dev-only packages are lower priority.
- A major-version bump often has breaking changes; note this before recommending it.
- Lock files (\`package-lock.json\`, \`pnpm-lock.yaml\`, \`Cargo.lock\`) must be committed; flag if they are gitignored.`,
  },
  {
    id: 'agent-blog',
    name: 'agent:blog',
    description: 'Generates a daily post from recent git commits — summarizes progress in plain language for a dev blog.',
    content: `Generate a daily dev blog post from recent commits.

1. Run \`git log --since=yesterday --oneline\`. If empty, run \`git log --oneline -10\`.
2. Write a concise post (under 400 words) focusing on the "why" and user impact — not file names.
3. Save to \`blog/YYYY-MM-DD.md\` (today's date). Create the \`blog/\` directory if it doesn't exist.
4. Match the style of existing posts in \`blog/\` if any exist.

## Gotchas
- Do not mention internal file paths unless meaningful to a reader (e.g. "added \`lib/retry.ts\`" → "added retry logic").
- If all commits are chores (dependency bumps, formatting), still write the post — summarize the maintenance intent.`,
  },
  {
    id: 'agent-ci-monitor',
    name: 'agent:ci-monitor',
    description: 'Checks GitHub Actions status and applies targeted fixes when CI fails.',
    content: `Check CI status and fix failures.

1. Run \`gh run list --limit 5\` to see recent workflow runs.
2. If the latest run failed, run \`gh run view <run-id> --log-failed\` to get the error.
3. Classify the failure: test failure / type error / lint error / build error / missing secret.
4. Apply a targeted fix — only touch what CI is failing on, nothing else.
5. Report: what failed, what you changed.

If CI is passing, say so and stop.

## Gotchas
- Read the full log, not just the summary — the root cause is often a few lines above the "Error" line.
- Type and lint errors: run the project's local check command first to reproduce before editing.
- Missing environment variables in CI are a common cause of failures that look like test failures — check the workflow's \`env:\` block.
- Do not disable or skip failing tests to make CI green — fix the underlying issue.`,
  },
  {
    id: 'agent-release-ready',
    name: 'agent:release-ready',
    description: 'Pre-flight check — verifies tests, types, lint, and git state before shipping.',
    content: `Pre-flight check before shipping. Run each step and report pass/fail.

First, read \`CLAUDE.md\` or \`package.json\` to find the project's test, type-check, and lint commands. Then:

1. Run the test command — all tests must pass.
2. Run the type-check command if the project uses TypeScript — zero errors.
3. Run the lint command — zero errors.
4. \`git status\` — any uncommitted changes that won't be in the release?
5. \`git log origin/HEAD..HEAD --oneline\` — summarize what's about to ship.
6. Scan changed files for \`TODO\`, \`FIXME\`, \`HACK\` comments.

## Output template

\`\`\`
## Release Readiness

**Verdict: READY | NOT READY**

| Check | Result |
|---|---|
| Tests | ✓ pass / ✗ N failures |
| Types | ✓ clean / ✗ N errors |
| Lint | ✓ clean / ✗ N errors |
| Uncommitted changes | none / N files |
| Commits to ship | N commits |
| TODOs in diff | none / list |

**Blockers:** (only if NOT READY)
- specific blocker
\`\`\`

## Gotchas
- If \`origin/main\` returns nothing, try \`origin/master\` — the default branch name varies by project.
- A build step is not required unless the CI explicitly runs one; type-check covers type safety without a full build.`,
  },
  {
    id: 'agent-gha-audit',
    name: 'agent:gha-audit',
    description: 'Audits GitHub Actions workflows and fills gaps for CI, release, and label management.',
    content: `Audit GitHub Actions configuration and create any missing workflows.

1. List \`.github/workflows/\` — read each workflow file.
2. Check for a **CI workflow** (runs tests + lint + type-check on push/PR). Detect the project's check commands from \`package.json\` / \`Makefile\` / \`CLAUDE.md\`. Create if missing.
3. Check for a **release workflow** if the project has a release process. Create if missing.
4. Verify action versions are pinned to current major (e.g. \`actions/checkout@v4\`).
5. Check that secrets required by workflows are documented (in README or CLAUDE.md).
6. Report: what exists, what was created, any version upgrades made.

## Gotchas
- Read the project's CLAUDE.md before creating workflows — it may specify the deploy mechanism (PM2, Docker, Fly.io, etc.), which determines what a deploy workflow should look like.
- When using \`actions/setup-node\`, pin the Node version to match \`engines.node\` in \`package.json\`.
- Semantic-release and GitHub release creation need \`permissions: contents: write\` in the workflow.
- Do not add Dependabot if the project already has it configured in \`.github/dependabot.yml\`.
- Action versions pinned only to a branch (e.g. \`@main\`) are a supply chain risk — use SHA pins or major-version tags.`,
  },
  {
    id: 'agent-readme-sync',
    name: 'agent:readme-sync',
    description: 'Verifies README.md and CLAUDE.md are accurate and updates them to match the current project state.',
    content: `Keep project documentation accurate.

1. Read \`README.md\` and \`CLAUDE.md\` (if they exist).
2. Read the project manifest (\`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, etc.), the top-level directory structure, and \`git log --oneline -20\`.
3. Identify outdated or missing content:
   - README: setup steps, commands, environment variables, feature list, architecture overview.
   - CLAUDE.md: dev commands, file layout, key patterns, any deprecated instructions.
4. Update both files in-place. Make the minimum changes needed to make them truthful.

Keep existing style and tone. Do not add sections that don't belong. Do not remove sections that are still accurate.

## Gotchas
- CLAUDE.md is authoritative for Claude's behavior — wrong commands here cause real problems. Verify every command you add by checking the actual project manifest scripts.
- Only document the public interface in README; implementation details belong in CLAUDE.md or inline comments.
- If a command in CLAUDE.md references a tool or pattern that no longer exists in the project, remove or update it.`,
  },
  {
    id: 'agent-tests',
    name: 'agent:tests',
    description: 'Adds missing tests for recently changed code, following the project\'s existing test conventions.',
    content: `Add missing tests for recently changed code.

1. Run \`git log --name-only --since="7 days ago" --pretty=format:\` to find recently changed files.
2. Find the project's test directory and existing test files — match their structure and naming exactly.
3. Identify the project's test runner: check \`package.json\` scripts, \`pyproject.toml\`, \`Makefile\`, or CLAUDE.md.
4. Pick the 1–3 highest-value gaps — prefer API routes and business logic over glue code.
5. Write focused tests matching the existing style:
   - Cover the golden path + 1–2 meaningful edge cases per exported function.
   - Follow the project's mocking conventions exactly (read existing tests first).
6. Run the test command — fix failures before finishing.
7. Report: which files were uncovered, what you added, final test count.

## Gotchas
- Read existing tests before writing any — test structure varies widely between projects.
- Mock only external side-effects (HTTP calls, file system, external processes); prefer real implementations for internal logic.
- Do not add tests for trivial code (type exports, re-exports, constants).
- Do not skip or disable failing tests to make the suite pass — fix the underlying issue.`,
  },
  {
    id: 'agent-self-improve',
    name: 'agent:self-improve',
    description: 'Reads this project\'s agents from TamTam and improves their prompts based on current project state.',
    content: `Improve agent prompts for this project using the TamTam API (http://localhost:1337).

1. Get the project name from \`package.json\` (\`name\` field) or \`CLAUDE.md\` heading.
2. Fetch agents: \`curl -s "http://localhost:1337/api/agents?project=<name>"\`
3. Read \`CLAUDE.md\` and \`git log --oneline -20\` for current project context.
4. For each agent: does the prompt reflect current patterns? Does it reference outdated commands or miss new gotchas?
5. Update improved agents:
   \`\`\`
   curl -s -X PATCH http://localhost:1337/api/agents/by-name \\
     -H "Content-Type: application/json" \\
     -d '{"project":"<name>","name":"<agent>","prompt":"<improved>"}'
   \`\`\`

Only update when the improvement is substantive. Do not change name, model, schedule, or skills — only \`prompt\`. Report what changed and why.

## Gotchas
- The TamTam API is local-only — do not attempt to reach it from a remote context.
- Shorter prompts are usually better; do not pad prompts with generic advice.
- If an agent's skill already provides the core behavior, the prompt should only add project-specific overrides, not restate the skill.`,
  },
  {
    id: 'agent-manage-agents',
    name: 'agent:manage-agents',
    description: 'Audits agents configured in TamTam for this project and creates, updates, or removes them to match the current project needs.',
    content: `Audit and manage TamTam agents for this project. The TamTam API runs at http://localhost:1337.

## Step 1 — gather context

1. Read \`CLAUDE.md\` to understand the project's stack, test command, and active conventions.
2. Run \`git log --oneline -20\` to understand recent activity and momentum.
3. Fetch the project name:
   - Node.js: \`jq -r .name package.json\`
   - Python: check \`pyproject.toml\` or \`CLAUDE.md\` heading.
   - Fallback: use the current directory name.

## Step 2 — fetch existing agents

\`\`\`bash
curl -s "http://localhost:1337/api/agents?project=<name>"
\`\`\`

Parse the \`agents\` array. Each agent has: \`id\`, \`name\`, \`prompt\`, \`skillIds\`, \`model\`, \`schedule\`, \`runner\`, \`enabled\`.

## Step 3 — decide what to change

Compare the current agents against what the project actually needs. Consider:

- **Test agent**: does the project have a test command? If no test agent exists and tests are present, create one that runs them and reports failures.
- **Review agent**: is there a recurring code-review need?
- **Stale agents**: agents referencing commands or paths that no longer exist should be updated or removed.
- **Duplicate purpose**: two agents doing the same thing — consolidate.
- **Missing schedule**: an agent with no schedule that should run regularly.

Do not create agents for things already covered. Do not create agents for hypothetical future needs.

## Step 4 — create agents

\`\`\`bash
curl -s -X POST http://localhost:1337/api/agents \\
  -H "Content-Type: application/json" \\
  -d '{
    "project": "<name>",
    "name": "<agent-name>",
    "prompt": "<task prompt>",
    "skillIds": [],
    "model": "sonnet",
    "schedule": "24h",
    "runner": "pm2",
    "enabled": true
  }'
\`\`\`

Model guidance: use \`haiku\` for fast/cheap tasks (summary, report), \`sonnet\` for most tasks, \`opus\` only for complex reasoning.

## Step 5 — update existing agents

\`\`\`bash
curl -s -X PATCH "http://localhost:1337/api/agents/by-name" \\
  -H "Content-Type: application/json" \\
  -d '{"project":"<name>","name":"<agent-name>","prompt":"<updated>"}'
\`\`\`

Only update \`prompt\` unless the user explicitly asks to change model/schedule/runner.

## Step 6 — delete agents

\`\`\`bash
curl -s -X DELETE "http://localhost:1337/api/agents/<agentId>"
\`\`\`

Only delete if the agent is clearly stale or broken — when in doubt, update instead.

## Output

Report what you did:
- Created: list agent names + purpose
- Updated: list agent names + what changed
- Deleted: list agent names + reason
- No change: agents that are fine as-is

## Gotchas
- The TamTam API is local-only; never call it from a remote context.
- \`skillIds\` is a JSON array of skill ID strings (e.g. \`["agent-tests"]\`). Use \`[]\` when composing a custom prompt without a built-in skill.
- Agent \`name\` must be unique per project. Reuse the existing \`id\` when patching via \`/api/agents/<id>\`.
- Prompt length should be concise — 3–8 sentences covering the task, output format, and one key gotcha. Long prompts slow the model and drift from the skill's core.
- Do not change another project's agents — filter strictly by this project's name.`,
  },
  {
    id: 'agent-docs-claude',
    name: 'agent:docs-claude',
    description: 'Audits CLAUDE.md for completeness — adds missing guidance on security, conventions, testing, and patterns.',
    content: `Audit this project's CLAUDE.md and fill any gaps that would cause Claude to behave incorrectly.

1. Read \`CLAUDE.md\` (create it if absent). Also read \`package.json\`, \`README.md\`, top-level directory structure.
2. Run \`git log --oneline -20\` to understand recent project momentum and active patterns.
3. Check each category and add a concise numbered-rules section for any gap:

**A. Dependency & Supply-Chain Security**
- Lock-file always committed; never install without it.
- Inspect \`postinstall\`/\`prepare\` scripts before adding any dep.
- Verify new packages on the registry (downloads, publish date) before adding.
- Never add a dep without explicit user approval; justify in commit message.
- Run audit after any dep change.

**B. Coding Conventions**
- Naming (files, functions, components), import style (aliases vs relative), async pattern, error handling approach, linter config.

**C. Testing Rules**
- Test runner command, test file locations, what must be tested vs skipped, mocking policy.

**D. Architecture & Patterns**
- Key abstractions that must be used (e.g. "all shell calls through lib/shell.ts").
- Banned patterns (e.g. "never use class components", "no raw SQL").
- File/folder layout for new code.

**E. Scope & Safety**
- What requires explicit approval (schema changes, force flags, secrets).
- Branch and commit conventions.

4. Write rules as short imperatives — actionable and project-specific, not generic advice.
5. Do not remove or rewrite existing content — only add or extend.
6. Commit: \`docs: fill CLAUDE.md gaps\`

## Gotchas
- Rules must be project-specific, not generic — "run tests before committing" adds no value; "run \`make test\`" does.
- Verify every command you write in CLAUDE.md against the actual project scripts; wrong commands cause real workflow failures.
- If CLAUDE.md already covers a category well, skip it and note it was adequate.
- Do not turn CLAUDE.md into a tutorial — assume Claude already knows general best practices.`,
  },
  {
    id: 'agent-senior-fullstack',
    name: 'agent:senior-fullstack',
    description: 'Fullstack engineer persona — code quality review, feature scaffolding, and architecture guidance for any stack.',
    content: `You are a senior fullstack engineer. Apply this expertise to whatever the user asks.

First, read \`CLAUDE.md\` (if it exists) and \`package.json\` / project manifest to understand the actual stack. Use the project's established patterns, not generic defaults.

**Stack Decision Matrix** (when the project has no established pattern):
| Concern | Default choice | When to deviate |
|---|---|---|
| API layer | REST via framework router | GraphQL only if client needs flexible querying |
| DB | SQL (SQLite for small, Postgres for multi-user) | NoSQL only for document stores or time-series |
| Auth | Session cookies + DB table | JWT only if stateless is a hard requirement |
| Testing | Built-in test runner (vitest/pytest/go test) | External framework only if the project already uses one |
| Styling | CSS modules or Tailwind | BEM/SCSS if the team is already invested |

**When scaffolding a new feature:**
1. Read existing similar features first — match structure and naming exactly.
2. Follow the project's file layout (check CLAUDE.md; if absent, match what exists).
3. Add tests matching the project's testing conventions.
4. Run \`npm audit\` (or the project's equivalent) before finishing if you added dependencies.

**When reviewing code quality:**
1. Security: injection, XSS, hardcoded secrets, insecure auth.
2. Type safety: no unchecked \`any\`, null guards where needed.
3. Test coverage: new public API surface should have tests.
4. Output findings as: P0 (critical/security), P1 (high impact), P2 (improvements).

## Gotchas
- Always match the existing project style — do not refactor beyond the scope of the task.
- If CLAUDE.md documents banned patterns or required abstractions, follow them strictly.
- Don't add dependencies without confirming they're appropriate for the project's ecosystem.`,
  },
];

let seeded = false;

export function seedDefaultSkills(): void {
  if (seeded) return;
  seeded = true;
  const now = Date.now() / 1000;
  for (const skill of DEFAULT_AGENT_SKILLS) {
    const existing = db.select().from(schema.skills).where(eq(schema.skills.id, skill.id)).get();
    if (!existing) {
      db.insert(schema.skills).values({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        createdAt: now,
        updatedAt: now,
      }).run();
    } else if (!existing.content) {
      db.update(schema.skills)
        .set({ content: skill.content, description: skill.description, updatedAt: now })
        .where(eq(schema.skills.id, skill.id))
        .run();
    }
  }
}
