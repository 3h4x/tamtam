import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('file-backed skill prerequisites', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.resetModules();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function importResolverWithSkill(prerequisite: string) {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-file-skill-prereq-'));
    const skillDir = join(tempDir, 'skills', 'docs', 'skills', 'tamtam');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'agent-custom.md'), `---
id: agent-custom
name: agent:custom
description: Custom agent
prerequisite: |
  ${prerequisite}
---

Use the custom agent.
`);
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: join(tempDir!, 'skills'),
      DATA_SKILLS_DIR: join(tempDir!, 'data-skills'),
    }));
    return import('@/lib/agents/file-skill-prerequisites');
  }

  it('reads file-backed prerequisite frontmatter and substitutes the project placeholder', async () => {
    const mod = await importResolverWithSkill('echo {{project}}');

    expect(mod.resolveFileBackedSkillPrerequisiteTemplate(['agent-custom'])).toBe('echo {{project}}');
    expect(mod.resolveAgentPrerequisiteCommandWithFileSkills({
      project: 'repo name/with space',
      skillIds: ['agent-custom'],
      prerequisiteCommand: undefined,
    })).toBe('echo repo%20name%2Fwith%20space');
  });

  it('preserves explicit stored prerequisite values over file-backed defaults', async () => {
    const mod = await importResolverWithSkill('echo {{project}}');

    expect(mod.resolveAgentPrerequisiteCommandWithFileSkills({
      project: 'proj',
      skillIds: ['agent-custom'],
      prerequisiteCommand: 'echo stored',
    })).toBe('echo stored');
    expect(mod.resolveAgentPrerequisiteCommandWithFileSkills({
      project: 'proj',
      skillIds: ['agent-custom'],
      prerequisiteCommand: '',
    })).toBeNull();
  });
});
