export const ISSUE_CRUNCHER_SKILL_ID = 'agent-issue-cruncher';
export const IMPROVE_SKILL_ID = 'agent-improve';

export function hasIssueCruncherSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(ISSUE_CRUNCHER_SKILL_ID);
}

export function hasImproveSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(IMPROVE_SKILL_ID);
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

// agent:improve prereq — runs in the project cwd. Outputs the top 5
// least-recently-modified candidate source files (with .tamtam/, node_modules,
// build artifacts, and *.d.ts filtered out) and the tail of the per-project
// audit log so the agent can skip files it already touched recently.
//
// Audit log lives under `.tamtam/cache/audits/<agent>.md`. The `cache/` subdir
// is gitignored by default via `lib/agents/agent-memory.ts:ensureTamtamCacheGitignore`,
// so every agent writing under it inherits the ignore for free — no per-file
// rule per agent.
export const IMPROVE_AUDIT_PATH = '.tamtam/cache/audits/improve.md';

export function buildImprovePrerequisiteCommand(): string {
  const find =
    `find app components lib hooks scripts docs -type f` +
    ` -not -path '*/.tamtam/*' -not -path '*/node_modules/*'` +
    ` -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/coverage/*'` +
    ` -not -name '*.d.ts'` +
    ` \\( -name '*.ts' -o -name '*.tsx' -o -name '*.md' -o -name '*.sh' \\)` +
    ` -printf '%TY-%Tm-%Td %p\\n' 2>/dev/null | sort | head -5`;
  return (
    `echo '## Top 5 oldest candidate files'; ${find}; ` +
    `echo; echo '## Recent improve runs (tail of ${IMPROVE_AUDIT_PATH})'; ` +
    `tail -10 ${IMPROVE_AUDIT_PATH} 2>/dev/null || echo '(no audit log yet)'`
  );
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
  if (hasIssueCruncherSkill(skillIds)) return buildIssueCruncherPrerequisiteCommand(project);
  if (hasImproveSkill(skillIds)) return buildImprovePrerequisiteCommand();
  return null;
}
