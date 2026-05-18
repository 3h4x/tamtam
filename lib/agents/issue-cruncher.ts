export const ISSUE_CRUNCHER_SKILL_ID = 'agent-issue-cruncher';

export function hasIssueCruncherSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(ISSUE_CRUNCHER_SKILL_ID);
}

export function normalizeStoredPrerequisiteCommand(
  prerequisiteCommand: string | null | undefined,
): string | null | undefined {
  if (prerequisiteCommand === null || prerequisiteCommand === undefined) return prerequisiteCommand;
  const trimmed = prerequisiteCommand.trim();
  return trimmed ? trimmed : '';
}

export function parsePrerequisiteCommandInput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed : '';
}

export function buildIssueCruncherPrerequisiteCommand(projectName: string): string {
  return `curl -fsS "http://localhost:1337/api/projects/by-project/${encodeURIComponent(projectName)}/issues?pick_top=1"`;
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
  const normalized = normalizeStoredPrerequisiteCommand(prerequisiteCommand);
  if (typeof normalized === 'string') return normalized || null;
  if (!hasIssueCruncherSkill(skillIds)) return null;
  return buildIssueCruncherPrerequisiteCommand(project);
}
