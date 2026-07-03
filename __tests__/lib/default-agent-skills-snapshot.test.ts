import { describe, it, expect, beforeAll } from 'vitest';
import { resetSeedModuleAndTables, selectAllSkills, waitForSeedToSettle } from './default-agent-skills-fixtures';

describe('seedDefaultSkills seeded defaults snapshot', () => {
  let seededSkills: Map<string, Awaited<ReturnType<typeof selectAllSkills>>[number]>;

  function getSeededSkill(id: string) {
    return seededSkills.get(id);
  }

  beforeAll(async () => {
    const seedFn = await resetSeedModuleAndTables();
    seedFn();
    await waitForSeedToSettle();
    seededSkills = new Map((await selectAllSkills()).map((skill) => [skill.id, skill]));
  });

  it('inserts all default skills on first call', () => {
    expect(seededSkills.size).toBeGreaterThanOrEqual(9);
  });

  it('inserts agent-self-improve with correct fields', () => {
    const skill = getSeededSkill('agent-self-improve');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:self-improve');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree, stop instead of guessing');
    expect(skill!.content).toContain('/api/agents/by-name');
    expect(skill!.description).toContain('TamTam');
  });

  it('inserts agent-docs-claude with correct fields', () => {
    const skill = getSeededSkill('agent-docs-claude');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:docs-claude');
    expect(skill!.description).toContain('CLAUDE.md');
    expect(skill!.content).toContain('CLAUDE.md');
    expect(skill!.content).toContain('package.json');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).not.toContain('git checkout');
    expect(skill!.content).not.toContain('git commit');
    expect(skill!.content).toContain("Don't run `git` commands");
  });

  it('inserts agent-cto with correct fields', () => {
    const skill = getSeededSkill('agent-cto');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:cto');
    expect(skill!.content).toContain('You are the CTO');
    expect(skill!.content).toContain('docs/*.md');
    expect(skill!.content).toContain('already implemented');
    expect(skill!.content).toContain('gh issue create');
    expect(skill!.content).toContain('human-needed');
    expect(skill!.content).toContain('## Problem');
    expect(skill!.content).toContain('## Proposed approach');
    expect(skill!.content).toContain('## Acceptance criteria');
    expect(skill!.content).toContain('- [ ]');
  });

  it('inserts agent-senior-fullstack with correct fields', () => {
    const skill = getSeededSkill('agent-senior-fullstack');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:senior-fullstack');
    expect(skill!.content).toContain('Senior fullstack engineer');
    expect(skill!.content).toContain('CLAUDE.md');
  });

  it('inserts agent-security-review with correct fields', () => {
    const skill = getSeededSkill('agent-security-review');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:security-review');
    expect(skill!.description).toContain('OWASP');
    expect(skill!.content).toContain('uncommitted changes');
    expect(skill!.content).not.toContain('git diff');
    expect(skill!.content).toContain('CLEAN | FINDINGS');
  });

  it('inserts agent-dependency-check with correct fields', () => {
    const skill = getSeededSkill('agent-dependency-check');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:dependency-check');
    expect(skill!.description).toContain('staleness');
    expect(skill!.content).toContain('audit');
    expect(skill!.content).toContain('outdated');
  });

  it('inserts agent-blog with correct fields', () => {
    const skill = getSeededSkill('agent-blog');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:blog');
    expect(skill!.description).toContain('blog');
    expect(skill!.content).toContain('recent file changes');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain("Don't run `git` commands");
    expect(skill!.content).toContain('blog/');
  });

  it('inserts agent-ci-monitor with correct fields', () => {
    const skill = getSeededSkill('agent-ci-monitor');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:ci-monitor');
    expect(skill!.description).toContain('CI');
    expect(skill!.content).toContain('gh run list');
    expect(skill!.content).toContain('gh run view');
  });

  it('inserts agent-issue-cruncher with correct fields', () => {
    const skill = getSeededSkill('agent-issue-cruncher');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:issue-cruncher');
    expect(skill!.description).toContain('ready-to-go issue');
    expect(skill!.content).toContain('current repo directory name');
    // v2026-05-29 reworded §1: only package.json-vs-directory disagreement stops;
    // the CLAUDE.md heading is informational and must NOT trigger a stop.
    expect(skill!.content).toContain('do NOT stop on a heading-vs-directory mismatch');
    expect(skill!.content).toContain('ISSUE_PROJECT_UNKNOWN');
    expect(skill!.content).toContain('tamtam-actions');
    expect(skill!.content).toContain('{type: "checkout-default"}');
    expect(skill!.content).toContain('{type: "issue-comment", number: <n>');
    expect(skill!.content).toContain('Do NOT `curl http://localhost:1337/...` for issue write operations');
    // §4 used to instruct the agent to POST /issue-branch; auto-checkout-on-pick
    // removed that step. The skill must now NOT mention /issue-branch.
    expect(skill!.content).not.toContain('/api/projects/by-project/<project>/issue-branch');
    // Skill must not tell the agent to run git directly. `git checkout` / `git switch`
    // DO appear in the Hard-rules deny list (see assertion below), so we only forbid
    // git-write verbs the skill should never mention in any context.
    expect(skill!.content).not.toContain('git commit');
    expect(skill!.content).not.toContain('git push');
    // Auto-checkout makes branch.name / branch.status part of the contract.
    expect(skill!.content).toContain('branch.name');
    expect(skill!.content).toContain('Do NOT run `git checkout` or `git switch`');
  });

  it('inserts agent-release-ready with correct fields', () => {
    const skill = getSeededSkill('agent-release-ready');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:release-ready');
    expect(skill!.description).toContain('Pre-flight');
    expect(skill!.content).toContain('READY');
    expect(skill!.content).toContain('NOT READY');
  });

  it('inserts agent-gha-audit with correct fields', () => {
    const skill = getSeededSkill('agent-gha-audit');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:gha-audit');
    expect(skill!.description).toContain('.github/workflows');
    expect(skill!.content).toContain('.github/workflows/');
    expect(skill!.content).toContain('CI workflow');
  });

  it('inserts agent-tests with correct fields', () => {
    const skill = getSeededSkill('agent-tests');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:tests');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain("Don't run `git` commands");
    expect(skill!.content).toContain('vi.useFakeTimers()');
    expect(skill!.content).toContain('test');
  });

  it('inserts agent-manage-agents with correct fields', () => {
    const skill = getSeededSkill('agent-manage-agents');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:manage-agents');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('project name from the current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/agents');
  });

  it('inserts agent-review-tuner with correct fields', () => {
    const skill = getSeededSkill('agent-review-tuner');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:review-tuner');
    expect(skill!.description).toContain('review/fix prompt tweaks');
    expect(skill!.content).toContain('Project name = current repo directory name');
    expect(skill!.content).toContain('if they disagree with the repo directory name, stop instead of guessing');
    expect(skill!.content).toContain('/api/projects/by-project/<name>/release/<id>');
  });

  it('inserts agent-qa with the supported Playwright MCP namespace', () => {
    const skill = getSeededSkill('agent-qa');
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
    expect(skill!.content).toMatch(/Fix up to 2/);
    expect(skill!.content).toMatch(/Hard stop conditions/);
    expect(skill!.content).not.toMatch(/cto agent|QA_NO_CTO/);
  });

  it('inserts agent-refactor-split with correct fields', () => {
    const skill = getSeededSkill('agent-refactor-split');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:refactor-split');
    expect(skill!.description).toContain("Consumes the improve agent's F6");
    expect(skill!.content).toContain('REFACTOR_SPLIT_DONE');
    expect(skill!.content).toContain('REFACTOR_SPLIT_SKIPPED');
    expect(skill!.content).toContain('REFACTOR_SPLIT_BLOCKED');
    expect(skill!.content).toContain('Read the ENTIRE target file first');
  });

  it('inserts agent-readme-sync with correct fields', () => {
    const skill = getSeededSkill('agent-readme-sync');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:readme-sync');
    expect(skill!.description).toContain('README');
    expect(skill!.content).toContain('README');
    expect(skill!.content).not.toContain('git log');
    expect(skill!.content).toContain('project manifest');
    expect(skill!.content).toContain("Don't run `git` commands");
  });

  it('no default skill content tells the model to run state-mutating git', () => {
    // Read-only git (log, diff, status, show, ls-files, blame, rev-parse) is
    // allowed because some agents legitimately need recent history or
    // working-tree scope. Write-class verbs belong only to the release
    // pipeline.
    const violators: string[] = [];
    for (const skill of seededSkills.values()) {
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
});

