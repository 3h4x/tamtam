export const ISSUE_CRUNCHER_SKILL_ID = 'agent-issue-cruncher';

export function hasIssueCruncherSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(ISSUE_CRUNCHER_SKILL_ID);
}

export function buildIssueCruncherPrerequisiteCommand(projectName: string): string {
  return `curl -fsS "http://localhost:1337/api/projects/by-project/${encodeURIComponent(projectName)}/issues?trusted_only=1"`;
}

export function resolveAgentPrerequisiteCommand({
  project,
  skillIds,
  prerequisiteCommand,
}: {
  project: string;
  skillIds: string[] | null | undefined;
  prerequisiteCommand: string | null | undefined;
}): string | null {
  const trimmed = prerequisiteCommand?.trim();
  if (trimmed) return trimmed;
  if (!hasIssueCruncherSkill(skillIds)) return null;
  return buildIssueCruncherPrerequisiteCommand(project);
}
