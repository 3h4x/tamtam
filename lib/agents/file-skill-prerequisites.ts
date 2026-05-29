import { findFileBackedSkill } from '@/lib/agents/skills-from-files';
import { resolveAgentPrerequisiteCommand } from '@/lib/agents/prerequisites';

export function resolveFileBackedSkillPrerequisiteTemplate(
  skillIds: string[] | null | undefined,
): string | null {
  if (!Array.isArray(skillIds)) return null;
  for (const skillId of skillIds) {
    const prerequisite = findFileBackedSkill(skillId)?.prerequisite;
    if (typeof prerequisite === 'string' && prerequisite.trim()) {
      return prerequisite;
    }
  }
  return null;
}

export function resolveAgentPrerequisiteCommandWithFileSkills({
  project,
  skillIds,
  prerequisiteCommand,
}: {
  project: string;
  skillIds: string[] | null | undefined;
  prerequisiteCommand: string | null | undefined;
}): string | null {
  return resolveAgentPrerequisiteCommand({
    project,
    skillIds,
    prerequisiteCommand,
    defaultPrerequisiteCommand: resolveFileBackedSkillPrerequisiteTemplate(skillIds),
  });
}
