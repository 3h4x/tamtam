import { describe, it, expect, beforeEach } from 'vitest';
import { findSkill, resetSeedModuleAndTables, selectAllSkills, sharedDefaultAgentSkillsHandle, waitForFast, waitForSeedToSettle } from './default-agent-skills-fixtures';
import * as schema from '@/lib/db/schema';

describe('seedDefaultSkills isolated cases', () => {
  let seedFn: typeof import('@/lib/agents/default-agent-skills').seedDefaultSkills;

  beforeEach(async () => {
    seedFn = await resetSeedModuleAndTables();
  });

  it('inserts agent-release-ready with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-release-ready');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:release-ready');
    expect(skill!.description).toContain('Pre-flight');
    expect(skill!.content).toContain('READY');
    expect(skill!.content).toContain('NOT READY');
  });

  it('inserts agent-gha-audit with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-gha-audit');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:gha-audit');
    expect(skill!.description).toContain('.github/workflows');
    expect(skill!.content).toContain('.github/workflows/');
    expect(skill!.content).toContain('CI workflow');
  });

  it('inserts agent-tests with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-tests');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:tests');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain("Don't run `git` commands");
    expect(skill!.content).toContain('vi.useFakeTimers()');
    expect(skill!.content).toContain('test');
  });

  it('inserts agent-manage-agents with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-manage-agents');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:manage-agents');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('project name from the current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/agents');
  });

  it('inserts agent-review-tuner with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-review-tuner');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:review-tuner');
    expect(skill!.description).toContain('review/fix prompt tweaks');
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/projects/by-project/<name>/release/<id>');
  });

  it('inserts agent-qa with the supported Playwright MCP namespace', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-qa');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:qa');
    expect(skill!.description).toContain('Playwright');
    expect(skill!.content).toContain('mcp__tamtam_browser__browser_navigate');
    expect(skill!.content).toContain('mcp__tamtam_browser__browser_snapshot');
    expect(skill!.content).toContain('mcp__tamtam_browser__browser_console_messages');
    expect(skill!.content).toContain('mcp__tamtam_browser__browser_take_screenshot');
    expect(skill!.content).toContain('mcp__tamtam_browser__browser_wait_for');
    expect(skill!.content).not.toMatch(/`browser_[^`]+`/);
    expect(skill!.content).not.toContain('Read `.tamtam/agents/<this-agent-name>.md` in the working tree');
    expect(skill!.content).not.toMatch(/read\s+`?\.tamtam\/agents/i);
    expect(skill!.content).toContain('Do not read `.tamtam/` files directly');
    expect(skill!.content).toContain('branch-aware config layer');
    expect(skill!.content).toContain('Clean up artifacts');
    expect(skill!.content).toContain('Track every artifact path you create during the run');
    expect(skill!.content).not.toContain('rm -f ./*.png');
    expect(skill!.content).not.toContain('rm -rf ./.playwright-mcp ./test-results ./playwright-report');
    expect(skill!.content).not.toContain('rm -rf ./test-results');
    expect(skill!.content).not.toContain('rm -rf ./playwright-report');
    expect(skill!.content).toContain('/api/projects/by-project/<name>/config');
    expect(skill!.content).toContain('QA_NO_TARGET');
    // Agent fixes 1–2 small issues itself, reports the rest. No cto handoff.
    expect(skill!.content).toMatch(/Fix up to 2/);
    expect(skill!.content).toMatch(/Hard stop conditions/);
    expect(skill!.content).not.toMatch(/cto agent|QA_NO_CTO/);
  });

  it('inserts agent-readme-sync with correct fields', async () => {
    seedFn();
    await waitForSeedToSettle();
    const skill = await findSkill('agent-readme-sync');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:readme-sync');
    expect(skill!.description).toContain('README');
    expect(skill!.content).toContain('README');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain('project manifest');
    expect(skill!.content).toContain("Don't run `git` commands");
  });

  it('no default skill content tells the model to run state-mutating git', async () => {
    // Read-only git (log, diff, status, show, ls-files, blame, rev-parse) is
    // allowed because some agents legitimately need recent history or
    // working-tree scope. Write-class verbs belong only to the release
    // pipeline.
    seedFn();
    await waitForSeedToSettle();
    const skills = await selectAllSkills();
    const violators: string[] = [];
    for (const skill of skills) {
      // Skip user-added rows from earlier tests — only enforce on default skills.
      if (!skill.id.startsWith('agent-')) continue;
      // issue-cruncher explicitly enumerates `git checkout` / `git switch` in
      // its Hard-rules deny list — that's a "do NOT run" instruction, not a
      // "run this" instruction. Exclude it from the heuristic.
      if (skill.id === 'agent-issue-cruncher') continue;
      const c = skill.content || '';
      if (/\bgit (checkout|switch|commit|push|pull|fetch|branch|stash|rebase|merge|reset|tag|add)\b/.test(c)) {
        violators.push(`${skill.id}: ${c.match(/\bgit \w+\b/)?.[0]}`);
      }
    }
    expect(violators).toEqual([]);
  });

  it('does not insert skills on second call (seeded guard)', async () => {
    seedFn();
    await waitForSeedToSettle();
    const countAfterFirst = (await selectAllSkills()).length;

    // Manually insert an extra row to detect if seed runs again
    await sharedDefaultAgentSkillsHandle.db.insert(schema.skills).values({
      id: 'canary',
      name: 'canary',
      description: '',
      content: 'x',
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
    });

    seedFn(); // second call — should be a no-op, not duplicate-insert
    // Drain microtasks: if seedFn had fired any work, its synchronous
    // .select().then(...) chains would have been scheduled by now. A few
    // microtask flushes lets any (incorrect) second-pass writes run if they
    // would, without paying a wall-clock sleep.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const allIds = (await selectAllSkills()).map((s) => s.id);
    // All original ids still present, no duplicates possible since id is PRIMARY KEY
    // The real assertion: row count is exactly countAfterFirst + 1 (canary only)
    expect(allIds.length).toBe(countAfterFirst + 1);
  });

  it('overwrites content and description on existing default skills (defaults are read-only)', async () => {
    const now = Date.now() / 1000;
    await sharedDefaultAgentSkillsHandle.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'custom-name',
      description: 'custom-desc',
      content: 'custom-content',
      createdAt: now,
      updatedAt: now,
    });

    seedFn();
    await waitForSeedToSettle();

    await waitForFast(async () => {
      const skill = await findSkill('agent-cto');
      // name is not part of the seed payload, so any prior value (including a
      // pre-existing customisation from before the read-only switch) survives.
      expect(skill!.name).toBe('custom-name');
      expect(skill!.content).not.toBe('custom-content');
      expect(skill!.content).toContain('CTO');
      expect(skill!.description).not.toBe('custom-desc');
    });
  });

  it('updates content and description for a skill that exists with empty content', async () => {
    const now = Date.now() / 1000;
    await sharedDefaultAgentSkillsHandle.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: '',
      content: '',
      createdAt: now,
      updatedAt: now,
    });

    seedFn();
    await waitForSeedToSettle();

    await waitForFast(async () => {
      const skill = await findSkill('agent-cto');
      expect(skill!.content).toContain('You are the CTO');
      expect(skill!.description.length).toBeGreaterThan(0);
    });
  });

});
