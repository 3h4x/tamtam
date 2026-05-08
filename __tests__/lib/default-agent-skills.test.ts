import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

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
    expect(skill!.content).toContain('/api/agents');
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
