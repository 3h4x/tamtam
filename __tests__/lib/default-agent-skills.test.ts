import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function sha256Prefix(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      doc_paths TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT,
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('seedDefaultSkills', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let seedFn: typeof import('@/lib/agents/default-agent-skills').seedDefaultSkills;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/agents/default-agent-skills');
    seedFn = mod.seedDefaultSkills;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('inserts all default skills on first call', () => {
    seedFn();
    const skills = testDb.db.select().from(schema.skills).all();
    expect(skills.length).toBeGreaterThanOrEqual(9);
  });

  it('inserts agent-self-improve with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-self-improve');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:self-improve');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree, stop instead of guessing');
    expect(skill!.content).toContain('/api/agents/by-name');
    expect(skill!.description).toContain('TamTam');
  });

  it('inserts agent-docs-claude with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-docs-claude');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:docs-claude');
    expect(skill!.description).toContain('CLAUDE.md');
    expect(skill!.content).toContain('CLAUDE.md');
    expect(skill!.content).toContain('package.json');
    // Skill prompts must NOT instruct the model to run git — TamTam owns
    // version control via the release pipeline.
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).not.toContain('git checkout');
    expect(skill!.content).not.toContain('git commit');
    expect(skill!.content).toContain("Don't run `git` commands");
  });

  it('inserts agent-cto with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:cto');
    expect(skill!.content).toContain('You are the CTO');
    expect(skill!.content).toContain('gh issue create');
    expect(skill!.content).toContain('## Problem');
    expect(skill!.content).toContain('## Proposed approach');
    expect(skill!.content).toContain('## Acceptance criteria');
    expect(skill!.content).toContain('- [ ]');
  });

  it('inserts agent-senior-fullstack with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-senior-fullstack');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:senior-fullstack');
    expect(skill!.content).toContain('Senior fullstack engineer');
    expect(skill!.content).toContain('CLAUDE.md');
  });

  it('inserts agent-security-review with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-security-review');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:security-review');
    expect(skill!.description).toContain('OWASP');
    expect(skill!.content).toContain('uncommitted changes');
    expect(skill!.content).not.toContain('git diff');
    expect(skill!.content).toContain('CLEAN | FINDINGS');
  });

  it('inserts agent-dependency-check with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-dependency-check');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:dependency-check');
    expect(skill!.description).toContain('staleness');
    expect(skill!.content).toContain('audit');
    expect(skill!.content).toContain('outdated');
  });

  it('inserts agent-blog with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-blog');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:blog');
    expect(skill!.description).toContain('blog');
    expect(skill!.content).toContain('recent file changes');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain("Don't run `git` commands");
    expect(skill!.content).toContain('blog/');
  });

  it('inserts agent-ci-monitor with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-ci-monitor');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:ci-monitor');
    expect(skill!.description).toContain('CI');
    expect(skill!.content).toContain('gh run list');
    expect(skill!.content).toContain('gh run view');
  });

  it('inserts agent-issue-cruncher with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-issue-cruncher');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:issue-cruncher');
    expect(skill!.description).toContain('ready-to-go issue');
    expect(skill!.content).toContain('current repo directory name');
    expect(skill!.content).toContain('If either disagrees with the repo directory name');
    expect(skill!.content).toContain('ISSUE_PROJECT_UNKNOWN');
    expect(skill!.content).toContain('/api/projects/by-project/<project>/checkout-default');
    expect(skill!.content).toContain('/api/projects/by-project/<project>/changes');
    expect(skill!.content).toContain('/api/projects/by-project/<project>/issue-branch');
    expect(skill!.content).not.toContain('git checkout');
    expect(skill!.content).not.toContain('git commit');
  });

  it('backfills the trusted-only prerequisite for existing issue-cruncher agents', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'issue-cruncher',
      project: 'proj1',
      skillIds: '["agent-issue-cruncher"]',
      docPaths: '[]',
      model: 'normal',
      prompt: '',
      schedule: null,
      runner: 'pm2',
      enabled: true,
      prerequisiteCommand: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const agent = testDb.db.select().from(schema.agents).all().find((row) => row.id === 'agent-1');
    expect(agent?.prerequisiteCommand).toBe('curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?trusted_only=1&slim=1"');
  });

  it('does not backfill an explicitly cleared issue-cruncher prerequisite', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.agents).values({
      id: 'agent-2',
      name: 'issue-cruncher',
      project: 'proj1',
      skillIds: '["agent-issue-cruncher"]',
      docPaths: '[]',
      model: 'normal',
      prompt: '',
      schedule: null,
      runner: 'pm2',
      enabled: true,
      prerequisiteCommand: '',
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const agent = testDb.db.select().from(schema.agents).all().find((row) => row.id === 'agent-2');
    expect(agent?.prerequisiteCommand).toBe('');
  });

  it('inserts agent-release-ready with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-release-ready');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:release-ready');
    expect(skill!.description).toContain('Pre-flight');
    expect(skill!.content).toContain('READY');
    expect(skill!.content).toContain('NOT READY');
  });

  it('inserts agent-gha-audit with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-gha-audit');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:gha-audit');
    expect(skill!.description).toContain('.github/workflows');
    expect(skill!.content).toContain('.github/workflows/');
    expect(skill!.content).toContain('CI workflow');
  });

  it('inserts agent-tests with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-tests');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:tests');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain("Don't run `git` commands");
    expect(skill!.content).toContain('vi.useFakeTimers()');
    expect(skill!.content).toContain('test');
  });

  it('inserts agent-manage-agents with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-manage-agents');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:manage-agents');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('project name from the current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/agents');
  });

  it('inserts agent-review-tuner with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-review-tuner');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:review-tuner');
    expect(skill!.description).toContain('review/fix prompt tweaks');
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/projects/by-project/<name>/release/<id>');
  });

  it('inserts agent-readme-sync with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-readme-sync');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:readme-sync');
    expect(skill!.description).toContain('README');
    expect(skill!.content).toContain('README');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain('project manifest');
    expect(skill!.content).toContain("Don't run `git` commands");
  });

  it('no default skill content tells the model to run git', () => {
    seedFn();
    const skills = testDb.db.select().from(schema.skills).all();
    const violators: string[] = [];
    for (const skill of skills) {
      // Skip user-added rows from earlier tests — only enforce on default skills.
      if (!skill.id.startsWith('agent-')) continue;
      const c = skill.content || '';
      if (/\bgit (log|diff|checkout|commit|push|pull|status|branch|stash|rebase|merge|reset|tag)\b/.test(c)) {
        violators.push(`${skill.id}: ${c.match(/\bgit \w+\b/)?.[0]}`);
      }
    }
    expect(violators).toEqual([]);
  });

  it('does not insert skills on second call (seeded guard)', () => {
    seedFn();
    const countAfterFirst = testDb.db.select().from(schema.skills).all().length;

    // Manually insert an extra row to detect if seed runs again
    testDb.db.insert(schema.skills).values({
      id: 'canary',
      name: 'canary',
      description: '',
      content: 'x',
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
    }).run();

    seedFn(); // second call — should be a no-op, not duplicate-insert
    const allIds = testDb.db.select().from(schema.skills).all().map((s) => s.id);
    // All original ids still present, no duplicates possible since id is PRIMARY KEY
    // The real assertion: row count is exactly countAfterFirst + 1 (canary only)
    expect(allIds.length).toBe(countAfterFirst + 1);
  });

  it('skips inserting a skill that already exists with content', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'custom-name',
      description: 'custom-desc',
      content: 'custom-content',
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.name).toBe('custom-name');
    expect(skill!.content).toBe('custom-content');
    expect(skill!.description).toBe('custom-desc');
  });

  it('updates content and description for a skill that exists with empty content', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: '',
      content: '',
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.content).toContain('You are the CTO');
    expect(skill!.description.length).toBeGreaterThan(0);
  });

  // Issue #64: when a seeded skill's content matches a hash in
  // KNOWN_DEFAULT_CONTENT_HASHES, seedDefaultSkills must overwrite it with the
  // current (shorter) default. This is the mechanism that actually shrinks
  // prompts on running installs — a typo in the hash list would silently
  // break the upgrade and let the cache-read regression persist.
  it('overwrites a seeded default whose content matches a known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content of agent-cto from before the issue-#64 rewrite.
    // sha256(...).slice(0,16) === 'a13c143efc007ea5', which is registered in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-cto'].
    const previousDefault = `You are the CTO of this project. Think strategically about the highest-leverage next steps and create actionable GitHub issues.

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
- Issues must be self-contained: a solo developer should be able to pick one up cold.`;

    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.content).not.toBe(previousDefault);
    // Current default is much shorter; the whole point of the upgrade.
    expect(skill!.content.length).toBeLessThan(previousDefault.length);
  });

  it('overwrites the immediately previous agent-cto default during template rollout', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the prompt shipped immediately before the
    // canonical issue-template rollout.
    // sha256(...).slice(0,16) === 'b9a1e7cd36ae83dd', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-cto'] so running installs upgrade.
    const previousDefault = `You are the CTO. Read CLAUDE.md and skim the codebase. List existing GitHub issues with \`gh issue list --limit 20 --state open\` so you don't duplicate.
Pick 2–3 highest-leverage gaps and file them with \`gh issue create\` — title states the outcome, body has problem → approach → acceptance criteria, labels include type + priority. Skip duplicates and in-progress work. Solo project: no team-coordination assumptions. Don't run \`git\` commands or branch/commit/push — TamTam's release pipeline owns version control.`;

    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('exact template below');
    expect(skill!.content).toContain('## Acceptance criteria');
    expect(skill!.content).toContain('- [ ] <verifiable outcome 1>');
  });

  it('overwrites the previous agent-issue-cruncher default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the first shipped issue-cruncher draft.
    // sha256(...).slice(0,16) === '362c85f7fe916df8', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-issue-cruncher'] so running
    // installs refresh to the self-contained project-resolution version.
    // The sha256Prefix assertion below proves the fixture content is the real
    // historical body — a typo here would mismatch the hash and the test
    // would still pass, masking a dead hash slot.
    const previousDefault = `You are the issue cruncher.

## 1. Pick an issue
- Run \`gh issue list --state open --limit 30 --json number,title,labels,body,assignees,url\`.
- Pick the most relevant ready-to-go issue:
  - Clear scope from the body or acceptance criteria.
  - No blocker labels: \`blocked\`, \`needs-info\`, \`needs-design\`, \`discussion\`, \`question\`.
  - Not assigned to someone else.
  - No open PR already linked to it.
  - Prefer \`good first issue\`, \`bug\`, \`enhancement\`; prefer small-to-medium effort.
- If nothing qualifies, print \`NO_ELIGIBLE_ISSUE\` and stop.

## 2. Validate before branching
- Skim every file path, function, and symbol the issue references. If anything named in the issue does not exist in the repo, or the reproduction cannot be followed, the issue is not ready.
- When not ready: comment on the issue explaining exactly what's missing, add the \`needs-info\` label with \`gh issue edit <n> --add-label needs-info\` (create it first with \`gh label create needs-info --color FBCA04\` if needed), switch back to the default branch via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/checkout-default" -H 'Content-Type: application/json' -d '{}'\`, fast-forward it via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/changes" -H 'Content-Type: application/json' -d '{"strategy":"ff-only"}'\`, print \`ISSUE_NEEDS_INFO <n>\`, and stop. Do not create a fix branch.

## 3. Do the work
- Comment on the issue announcing start.
- Create the issue branch through TamTam's local API: \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/issue-branch" -H 'Content-Type: application/json' -d '{"issue_number":<n>,"issue_title":"<title>"}'\`. The resulting branch is \`fix/issue-<n>-<slug>\` with a lowercase hyphenated slug <=40 chars from the title.
- Implement the fix. Keep the diff minimal and on-topic.
- Stop after implementation. Do not run tests, review, commit, push, or merge; TamTam's release pipeline handles the rest.`;

    // Verify the fixture content actually produces the claimed hash — this is the contract test.
    expect(sha256Prefix(previousDefault)).toBe('362c85f7fe916df8');

    testDb.db.insert(schema.skills).values({
      id: 'agent-issue-cruncher',
      name: 'agent:issue-cruncher',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-issue-cruncher');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('current repo directory name');
    expect(skill!.content).toContain('ISSUE_PROJECT_UNKNOWN');
  });

  it('overwrites the non-canonical agent-issue-cruncher default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the prompt shipped immediately before canonical
    // repo-directory project resolution.
    // sha256(...).slice(0,16) === '2753dcc26f2f434c', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-issue-cruncher'] so running
    // installs refresh away from the non-canonical project-name heuristic.
    // The sha256Prefix assertion below is the contract test: it proves the
    // fixture body is the real historical prompt, not a plausible substitute.
    const previousDefault = `You are the issue cruncher.

## 1. Resolve project context
- Derive the TamTam project name from \`package.json\`, the CLAUDE.md heading, or the repo directory name.
- Use that exact value in every \`/api/projects/by-project/<project>/...\` call below.
- If you cannot determine the project name confidently, print \`ISSUE_PROJECT_UNKNOWN\` and stop.

## 2. Pick an issue
- Run \`gh issue list --state open --limit 30 --json number,title,labels,body,assignees,url\`.
- Pick the most relevant ready-to-go issue:
  - Clear scope from the body or acceptance criteria.
  - No blocker labels: \`blocked\`, \`needs-info\`, \`needs-design\`, \`discussion\`, \`question\`.
  - Not assigned to someone else.
  - No open PR already linked to it.
  - Prefer \`good first issue\`, \`bug\`, \`enhancement\`; prefer small-to-medium effort.
- If nothing qualifies, print \`NO_ELIGIBLE_ISSUE\` and stop.

## 3. Validate before branching
- Skim every file path, function, and symbol the issue references. If anything named in the issue does not exist in the repo, or the reproduction cannot be followed, the issue is not ready.
- When not ready: comment on the issue explaining exactly what's missing, add the \`needs-info\` label with \`gh issue edit <n> --add-label needs-info\` (create it first with \`gh label create needs-info --color FBCA04\` if needed), switch back to the default branch via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/checkout-default" -H 'Content-Type: application/json' -d '{}'\`, fast-forward it via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/changes" -H 'Content-Type: application/json' -d '{"strategy":"ff-only"}'\`, print \`ISSUE_NEEDS_INFO <n>\`, and stop. Do not create a fix branch.

## 4. Do the work
- Comment on the issue announcing start.
- Create the issue branch through TamTam's local API: \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/issue-branch" -H 'Content-Type: application/json' -d '{"issue_number":<n>,"issue_title":"<title>"}'\`. The resulting branch is \`fix/issue-<n>-<slug>\` with a lowercase hyphenated slug <=40 chars from the title.
- Implement the fix. Keep the diff minimal and on-topic.
- Stop after implementation. Do not run tests, review, commit, push, or merge; TamTam's release pipeline handles the rest.`;

    // Contract test: fixture content must produce the exact claimed hash.
    expect(sha256Prefix(previousDefault)).toBe('2753dcc26f2f434c');

    testDb.db.insert(schema.skills).values({
      id: 'agent-issue-cruncher',
      name: 'agent:issue-cruncher',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-issue-cruncher');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('current repo directory name');
    expect(skill!.content).toContain('If either disagrees with the repo directory name');
  });

  it('overwrites the previous shipped issue-cruncher default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the previously shipped prompt immediately before
    // the trusted-issues prerequisite-output hardening.
    // sha256(...).slice(0,16) === '554fcf2c7671a896', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-issue-cruncher'] so running
    // installs refresh to the trusted-only prerequisite-output version.
    // The sha256Prefix assertion below is the contract test for this fixture.
    const previousDefault = String.raw`You are the issue cruncher.

## 1. Resolve project context
- Derive the TamTam project name from the current repo directory name (the folder containing \`.git\`). TamTam's \`/api/projects/by-project/<project>/...\` routes use that exact tracked directory name as the project key.
- Sanity-check \`package.json\` and the CLAUDE.md heading only. If either disagrees with the repo directory name, print \`ISSUE_PROJECT_UNKNOWN\` and stop instead of guessing.
- Use the repo directory name value in every \`/api/projects/by-project/<project>/...\` call below.

## 2. Pick an issue
- Run \`gh issue list --state open --limit 30 --json number,title,labels,body,assignees,url\`.
- Pick the most relevant ready-to-go issue:
  - Clear scope from the body or acceptance criteria.
  - No blocker labels: \`blocked\`, \`needs-info\`, \`needs-design\`, \`discussion\`, \`question\`.
  - Not assigned to someone else.
  - No open PR already linked to it.
  - Prefer \`good first issue\`, \`bug\`, \`enhancement\`; prefer small-to-medium effort.
- If nothing qualifies, print \`NO_ELIGIBLE_ISSUE\` and stop.

## 3. Validate before branching
- Skim every file path, function, and symbol the issue references. If anything named in the issue does not exist in the repo, or the reproduction cannot be followed, the issue is not ready.
- When not ready: comment on the issue explaining exactly what's missing, add the \`needs-info\` label with \`gh issue edit <n> --add-label needs-info\` (create it first with \`gh label create needs-info --color FBCA04\` if needed), switch back to the default branch via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/checkout-default" -H 'Content-Type: application/json' -d '{}'\`, fast-forward it via \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/changes" -H 'Content-Type: application/json' -d '{"strategy":"ff-only"}'\`, print \`ISSUE_NEEDS_INFO <n>\`, and stop. Do not create a fix branch.

## 4. Do the work
- Comment on the issue announcing start.
- Create the issue branch through TamTam's local API: \`curl -s -X POST "http://localhost:1337/api/projects/by-project/<project>/issue-branch" -H 'Content-Type: application/json' -d '{"issue_number":<n>,"issue_title":"<title>"}'\`. The resulting branch is \`fix/issue-<n>-<slug>\` with a lowercase hyphenated slug <=40 chars from the title.
- Implement the fix. Keep the diff minimal and on-topic.
- Stop after implementation. Do not run tests, review, commit, push, or merge; TamTam's release pipeline handles the rest.`;

    expect(sha256Prefix(previousDefault)).toBe('554fcf2c7671a896');

    testDb.db.insert(schema.skills).values({
      id: 'agent-issue-cruncher',
      name: 'agent:issue-cruncher',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-issue-cruncher');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('Prerequisite Output');
    expect(skill!.content).toContain("Do not run `gh issue list` directly");
  });

  it('overwrites the previous agent-self-improve default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the previously shipped prompt before canonical
    // repo-directory project resolution.
    // sha256(...).slice(0,16) === '441fabde58b560b7', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-self-improve'] so running installs
    // refresh to the canonical TamTam project-key version.
    const previousDefault = `TamTam API at http://localhost:1337 (local-only).
1. Project name from package.json or CLAUDE.md heading.
2. \`curl -s "http://localhost:1337/api/agents?project=<name>"\`
3. Read CLAUDE.md and skim the codebase for current patterns.
4. For each agent, decide if its prompt reflects current patterns. If yes, skip.
5. \`curl -X PATCH http://localhost:1337/api/agents/by-name -H 'Content-Type: application/json' -d '{"project":"<n>","name":"<a>","prompt":"<improved>"}'\`

Only patch \`prompt\`. Shorter is better. Don't restate the skill. Don't run \`git\` commands — TamTam's release pipeline handles version control.`;

    testDb.db.insert(schema.skills).values({
      id: 'agent-self-improve',
      name: 'agent:self-improve',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-self-improve');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree, stop instead of guessing');
  });

  it('overwrites the previous agent-manage-agents default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the previously shipped prompt before canonical
    // repo-directory project resolution.
    // sha256(...).slice(0,16) === '2f49c23946d7bd2f', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-manage-agents'] so running installs
    // refresh to the canonical TamTam project-key version.
    const previousDefault = `TamTam API at http://localhost:1337 (local-only).

Gather: CLAUDE.md, project name (jq package.json / pyproject.toml / dir name), and current activity by skimming the codebase.
Fetch: \`curl -s "http://localhost:1337/api/agents?project=<name>"\` — fields: id, name, prompt, skillIds, model, schedule, runner, enabled.

Decide changes: missing test agent? stale agents referencing dead paths? duplicate purpose? missing schedule? Don't create for hypothetical needs.

Create: \`POST /api/agents\` with \`{project, name, prompt, skillIds: [], model, schedule, runner: "pm2", enabled: true}\`. Prefer semantic tiers: fast for cheap tasks, normal for the default, smart only for hard reasoning. Legacy haiku/sonnet/opus aliases still resolve.
Update: \`PATCH /api/agents/by-name\` (\`prompt\` only unless asked).
Delete: \`DELETE /api/agents/<id>\` only when stale/broken.

Report: created, updated, deleted, no-change. Filter strictly by this project. Keep prompts 3–8 sentences. Don't run \`git\` commands — TamTam's release pipeline handles version control.`;

    testDb.db.insert(schema.skills).values({
      id: 'agent-manage-agents',
      name: 'agent:manage-agents',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-manage-agents');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('project name from the current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
  });

  it('overwrites the previous agent-review-tuner default via known hash', () => {
    const now = Date.now() / 1000;
    // Verbatim content from the previously shipped prompt before canonical
    // repo-directory project resolution.
    // sha256(...).slice(0,16) === 'f156455212bb6bfc', which must stay in
    // KNOWN_DEFAULT_CONTENT_HASHES['agent-review-tuner'] so running installs
    // refresh to the canonical TamTam project-key version.
    const previousDefault = `Project name from package.json or CLAUDE.md heading. TamTam API at http://localhost:1337 (local-only).

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
Do NOT PATCH any settings. Surface proposals only — the user applies them in the Config tab.`;

    testDb.db.insert(schema.skills).values({
      id: 'agent-review-tuner',
      name: 'agent:review-tuner',
      description: 'old',
      content: previousDefault,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-review-tuner');
    expect(skill!.content).not.toBe(previousDefault);
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
  });

  it('preserves a user-customised skill (hash does not match a known default)', () => {
    const now = Date.now() / 1000;
    const customised = 'You are the CTO. My custom instructions go here.';
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: 'mine',
      content: customised,
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.content).toBe(customised);
  });

  it('does not modify updatedAt for skills that already have content', () => {
    const oldTime = 1_000_000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: 'old',
      content: 'existing content',
      createdAt: oldTime,
      updatedAt: oldTime,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.updatedAt).toBe(oldTime);
  });

  it('sets updatedAt to a recent timestamp when backfilling empty content', () => {
    const oldTime = 1_000_000;
    const before = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: '',
      content: '',
      createdAt: oldTime,
      updatedAt: oldTime,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.updatedAt).toBeGreaterThanOrEqual(before);
  });
});
