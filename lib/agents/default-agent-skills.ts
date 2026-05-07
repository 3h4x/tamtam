import { createHash } from 'crypto';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

interface DefaultSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

// Skill bodies are deliberately terse. Every line lands in the prompt prefix
// and is read back from cache on every tool turn — verbose "## Gotchas"
// sections used to dominate cache-read spend (issue #64). Keep each skill
// under ~30 lines and resist re-stating Claude's defaults.
const DEFAULT_AGENT_SKILLS: DefaultSkill[] = [
  {
    id: 'agent-cto',
    name: 'agent:cto',
    description: 'Strategic next-step issues from project state.',
    content: `You are the CTO. Read CLAUDE.md, \`git log --oneline -30\`, and \`gh issue list --limit 20 --state open\`.
Pick 2–3 highest-leverage gaps and create issues with \`gh issue create\` — title states the outcome, body has problem → approach → acceptance criteria, labels include type + priority. Skip duplicates and in-progress work. Solo project: no team-coordination assumptions.`,
  },
  {
    id: 'agent-security-review',
    name: 'agent:security-review',
    description: 'OWASP review of the uncommitted diff.',
    content: `Run \`git diff HEAD\` and review the delta only. Check: hardcoded secrets (\`ghp_\`, \`sk-\`, \`AKIA\`…), shell/SQL injection, XSS (\`innerHTML\`, \`dangerouslySetInnerHTML\`), missing authz on routes that accept an ID, exposed admin endpoints, new dependency CVEs (run \`npm/pnpm/pip-audit/cargo audit\`).

Output:
\`\`\`
## Security Review — [project]
**Verdict: CLEAN | FINDINGS**
| Severity | File:Line | Issue | Fix |
\`\`\`
Skip framework-escaped output and parameterized queries.`,
  },
  {
    id: 'agent-dependency-check',
    name: 'agent:dependency-check',
    description: 'Audit deps for vulnerabilities and staleness.',
    content: `Detect ecosystem, run the audit + outdated commands, prioritize packages that are both vulnerable and outdated.

\`\`\`
## Dependency Audit — [project]
### Vulnerable & outdated
| Package | Current | Recommended | Severity | CVE |
### Outdated (no CVE)
| Package | Current | Latest | Notes |
**Recommendation:** [one sentence]
\`\`\`
Dev-only CVEs are lower priority. Note breaking changes on major bumps.`,
  },
  {
    id: 'agent-blog',
    name: 'agent:blog',
    description: 'Daily dev blog post from recent commits.',
    content: `Run \`git log --since=yesterday --oneline\` (fall back to \`-10\`). Write under 400 words focused on user impact, not file names. Save to \`blog/YYYY-MM-DD.md\`. Match existing post style if any.`,
  },
  {
    id: 'agent-ci-monitor',
    name: 'agent:ci-monitor',
    description: 'Check CI and apply targeted fixes when red.',
    content: `\`gh run list --limit 5\`. If the latest failed: \`gh run view <id> --log-failed\`, classify (test/type/lint/build/secret), apply a minimal fix touching only what's broken. Do not skip tests to make CI green. Reproduce locally before editing. If green, say so and stop.`,
  },
  {
    id: 'agent-release-ready',
    name: 'agent:release-ready',
    description: 'Pre-flight check before shipping.',
    content: `Read CLAUDE.md / package.json for commands. Run tests, type-check, lint. Check \`git status\` and \`git log origin/HEAD..HEAD --oneline\`. Scan diff for TODO/FIXME/HACK.

\`\`\`
## Release Readiness
**Verdict: READY | NOT READY**
| Check | Result |
**Blockers:** (only if NOT READY)
\`\`\`
Try \`origin/master\` if \`origin/main\` is missing.`,
  },
  {
    id: 'agent-gha-audit',
    name: 'agent:gha-audit',
    description: 'Audit and fill gaps in .github/workflows.',
    content: `Read \`.github/workflows/\`. Ensure: a CI workflow (tests + lint + types on push/PR), a release workflow if applicable, action versions pinned to current major or SHA, secrets documented. Match deploy mechanism in CLAUDE.md. Don't duplicate Dependabot if already configured. Report what existed, what was created, what was upgraded.`,
  },
  {
    id: 'agent-readme-sync',
    name: 'agent:readme-sync',
    description: 'Keep README.md and CLAUDE.md accurate.',
    content: `Read README, CLAUDE.md, the project manifest, top-level dirs, \`git log --oneline -20\`. Update outdated/missing setup, commands, env vars, file layout. Verify every command against actual scripts. Minimum changes; preserve existing tone. Don't remove still-accurate sections.`,
  },
  {
    id: 'agent-tests',
    name: 'agent:tests',
    description: 'Add tests for recently changed code.',
    content: `\`git log --name-only --since="7 days ago" --pretty=format:\` to find changes. Read existing tests first to match structure and mocking conventions exactly. Pick 1–3 highest-value gaps (API routes, business logic > glue). Cover golden path + 1–2 edge cases per export. Run the test command; fix failures. Don't test trivial code or skip failing tests.

NO WALL-CLOCK WAITS. If the code under test uses debouncing, setTimeout, setInterval, requestAnimationFrame, or any timer: install fake timers (\`vi.useFakeTimers()\` / \`jest.useFakeTimers()\`) in beforeEach and \`vi.useRealTimers()\` in afterEach. Drive time forward with \`vi.advanceTimersByTime(ms)\` / \`vi.runAllTimers()\`. Never \`await new Promise(r => setTimeout(r, N))\` to "wait for the debounce" — that's real wall-clock time and will torch CI minutes.

USER-EVENT + FAKE TIMERS. \`userEvent.type\` stalls under fake timers because each keystroke awaits a real-time delay. Either: (a) configure once with \`const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })\` and use \`user.type\`, or (b) fire the input change directly (\`fireEvent.change(input, { target: { value: '...' } })\`) when the test only cares about the resulting handler call — not the keystroke choreography.

BUDGET. A new unit test should finish in <500ms. After writing one, run \`pnpm vitest run <file> --reporter=verbose\` and read the duration. If a single test exceeds 1s, you have a real timer somewhere — fix it before committing. Slow tests are a recurring offence; treat duration as part of correctness, not a nice-to-have.`,
  },
  {
    id: 'agent-self-improve',
    name: 'agent:self-improve',
    description: 'Improve this project\'s agents in TamTam.',
    content: `TamTam API at http://localhost:1337 (local-only).
1. Project name from package.json or CLAUDE.md heading.
2. \`curl -s "http://localhost:1337/api/agents?project=<name>"\`
3. Read CLAUDE.md and \`git log --oneline -20\`.
4. For each agent, decide if its prompt reflects current patterns. If yes, skip.
5. \`curl -X PATCH http://localhost:1337/api/agents/by-name -H 'Content-Type: application/json' -d '{"project":"<n>","name":"<a>","prompt":"<improved>"}'\`

Only patch \`prompt\`. Shorter is better. Don't restate the skill.`,
  },
  {
    id: 'agent-manage-agents',
    name: 'agent:manage-agents',
    description: 'CRUD agents in TamTam to match project needs.',
    content: `TamTam API at http://localhost:1337 (local-only).

Gather: CLAUDE.md, \`git log --oneline -20\`, project name (jq package.json / pyproject.toml / dir name).
Fetch: \`curl -s "http://localhost:1337/api/agents?project=<name>"\` — fields: id, name, prompt, skillIds, model, schedule, runner, enabled.

Decide changes: missing test agent? stale agents referencing dead paths? duplicate purpose? missing schedule? Don't create for hypothetical needs.

Create: \`POST /api/agents\` with \`{project, name, prompt, skillIds: [], model, schedule, runner: "pm2", enabled: true}\`. Prefer semantic tiers: fast for cheap tasks, normal for the default, smart only for hard reasoning. Legacy haiku/sonnet/opus aliases still resolve.
Update: \`PATCH /api/agents/by-name\` (\`prompt\` only unless asked).
Delete: \`DELETE /api/agents/<id>\` only when stale/broken.

Report: created, updated, deleted, no-change. Filter strictly by this project. Keep prompts 3–8 sentences.`,
  },
  {
    id: 'agent-docs-claude',
    name: 'agent:docs-claude',
    description: 'Fill gaps in CLAUDE.md.',
    content: `Read CLAUDE.md (create if absent), package.json, README, top-level dirs, \`git log --oneline -20\`. If a \`docs/\` directory exists, read the first 30 lines of each \`*.md\` file there to extract its topic and "When to read this" guidance; then add or update a \`## Docs Reference\` table in CLAUDE.md with columns File | Topic | Load when — one row per doc file. Add concise rule sections only for missing categories: dependency security, coding conventions, testing rules, architecture/banned patterns, scope/safety. Rules are short imperatives, project-specific. Verify every command against actual scripts. Don't rewrite existing content. Commit: \`docs: fill CLAUDE.md gaps\`.`,
  },
  {
    id: 'agent-review-tuner',
    name: 'agent:review-tuner',
    description: 'Analyse recent releases and propose review/fix prompt tweaks.',
    content: `Project name from package.json or CLAUDE.md heading. TamTam API at http://localhost:1337 (local-only).

1. \`curl -s "http://localhost:1337/api/jobs?project=<name>&kind=release&limit=20"\` — last release meta-jobs.
2. For each release id: \`curl -s "http://localhost:1337/api/projects/by-project/<name>/release/<id>"\` — step list with verdicts, durations, log excerpts.
3. \`curl -s "http://localhost:1337/api/projects/by-project/<name>/config"\` — current \`review_prompt_addendum\` and \`fix_prompt_addendum\`.

Look for patterns:
- Review repeatedly flags the same false positive → propose \`review_prompt_addendum\` text loosening that rule.
- Fix loops repeatedly hit the 3-iteration cap → propose \`fix_prompt_addendum\` text clarifying intent or constraining scope.
- DO NOT SHIP verdicts on cosmetic findings → propose narrowing review scope.

Output (in your TamTam Run Report):
\`\`\`
## Review Tuner — [project]
### Last N releases
| Release | Verdict | Fix iters | Outcome |
### Proposed changes
- review_prompt_addendum: <text or "no change">
- fix_prompt_addendum: <text or "no change">
- Confidence: low | medium | high
\`\`\`
Do NOT PATCH any settings. Surface proposals only — the user applies them in the Config tab.`,
  },
  {
    id: 'agent-senior-fullstack',
    name: 'agent:senior-fullstack',
    description: 'Senior fullstack engineer persona.',
    content: `Senior fullstack engineer. Read CLAUDE.md and the manifest first; follow the project's established patterns. When scaffolding: match existing similar features exactly, add tests in the project's style, audit any new deps. When reviewing: flag P0 (security/critical), P1 (high impact), P2 (improvements). Don't refactor beyond the task's scope.`,
  },
];

// SHA-256 (first 16 hex chars) of every previously-shipped default content per
// skill id. When an existing seeded skill's content hashes to one of these, it
// is the unmodified default and we can safely overwrite with the current
// version — this lets us actually shrink prompts on running installs (issue
// #64), while still preserving any user customisation.
const KNOWN_DEFAULT_CONTENT_HASHES: Record<string, string[]> = {
  'agent-cto': ['a13c143efc007ea5'],
  'agent-security-review': ['ca362666deba8013'],
  'agent-dependency-check': ['7a470f6f6b45a900'],
  'agent-blog': ['b020ce4f0b6c4d7a'],
  'agent-ci-monitor': ['4ca89e530c8eaf95'],
  'agent-release-ready': ['4677689a0e0667df'],
  'agent-gha-audit': ['f8250345bd7da948'],
  'agent-readme-sync': ['28e3cb210b152a02'],
  'agent-tests': ['fb8477be3f13e216'],
  'agent-self-improve': ['a5a48f854a97f7b3'],
  'agent-manage-agents': ['6afb7cebf46efee8'],
  'agent-docs-claude': ['53267ca2a0043218', 'c2a96b81a863ae7f'],
  'agent-senior-fullstack': ['ab7344ee6a0a7a21'],
};

function isUnmodifiedDefault(id: string, existingContent: string): boolean {
  const known = KNOWN_DEFAULT_CONTENT_HASHES[id];
  if (!known) return false;
  const h = createHash('sha256').update(existingContent).digest('hex').slice(0, 16);
  return known.includes(h);
}

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
    } else if (!existing.content || isUnmodifiedDefault(skill.id, existing.content)) {
      db.update(schema.skills)
        .set({ content: skill.content, description: skill.description, updatedAt: now })
        .where(eq(schema.skills.id, skill.id))
        .run();
    }
  }
}
