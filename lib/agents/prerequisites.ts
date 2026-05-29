export {
  IMPROVE_AUDIT_PATH,
  IMPROVE_SKILL_ID,
  ISSUE_CRUNCHER_SKILL_ID,
  QA_SKILL_ID,
} from '@/lib/agents/skill-ids';
import {
  IMPROVE_AUDIT_PATH,
  IMPROVE_SKILL_ID,
  ISSUE_CRUNCHER_SKILL_ID,
  QA_SKILL_ID,
} from '@/lib/agents/skill-ids';

export function hasIssueCruncherSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(ISSUE_CRUNCHER_SKILL_ID);
}

export function hasImproveSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(IMPROVE_SKILL_ID);
}

export function hasQaSkill(skillIds: string[] | null | undefined): boolean {
  return Array.isArray(skillIds) && skillIds.includes(QA_SKILL_ID);
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

export function buildQaPrerequisiteCommand(projectName: string): string {
  const url = `http://localhost:1337/api/projects/by-project/${encodeURIComponent(projectName)}/config`;
  return (
    `echo '## QA target config (resolved by prereq — do NOT re-curl)'; ` +
    `curl -fsS "${url}" 2>/dev/null ` +
    `|| echo '{"error":"tamtam config service unreachable from host"}'`
  );
}

export function buildImprovePrerequisiteCommand(): string {
  const candidates =
    `stat_mode=$(if stat --version >/dev/null 2>&1; then printf gnu; else printf bsd; fi); ` +
    `{ git ls-files 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; }` +
    ` | grep -Ei '\\.(ts|tsx|js|jsx|sol|py|rs|go|md|sh)$'` +
    ` | grep -v '\\.d\\.ts$'` +
    ` | grep -Ev '\\.(gen|generated)\\.[^/]+$'` +
    ` | grep -Ev '(^|/)(\\.tamtam|node_modules)/'` +
    ` | grep -Ev '(^|/)(__snapshots__|__fixtures__|fixtures|e2e-results|test-results|playwright-report|coverage|dist|build|out)/'` +
    ` | grep -Ev '(^|/)(CHANGELOG|LICENSE|LICENCE)(\\.md)?$'` +
    ` | grep -v '^docs/superpowers/plans/'` +
    ` | grep -v '^docs/superpowers/specs/'` +
    ` | while IFS= read -r f; do` +
    ` if [ "$stat_mode" = gnu ]; then d=$(stat -c '%Y' "$f" 2>/dev/null); else d=$(stat -f '%m' "$f" 2>/dev/null); fi;` +
    ` [ -n "$d" ] && printf '%s %s\\n' "$d" "$f";` +
    ` done | sort -n | head -5`;
  return (
    `echo '## Top 5 oldest candidate files'; ${candidates}; ` +
    `echo; echo '## Recent improve runs (tail of ${IMPROVE_AUDIT_PATH})'; ` +
    `tail -10 ${IMPROVE_AUDIT_PATH} 2>/dev/null || echo '(no audit log yet)'`
  );
}

export function substitutePrerequisiteProjectPlaceholder(command: string, projectName: string): string {
  return command.replaceAll('{{project}}', encodeURIComponent(projectName));
}

export function resolveAgentPrerequisiteCommand({
  project,
  skillIds,
  prerequisiteCommand,
  defaultPrerequisiteCommand,
}: {
  project: string;
  skillIds: string[] | null | undefined;
  prerequisiteCommand: string | null | undefined;
  defaultPrerequisiteCommand?: string | null | undefined;
}): string | null {
  const normalized = normalizeStoredPrerequisiteCommand(prerequisiteCommand);
  if (typeof normalized === 'string') return normalized || null;
  const normalizedDefault = normalizeStoredPrerequisiteCommand(defaultPrerequisiteCommand);
  if (typeof normalizedDefault === 'string') {
    return normalizedDefault
      ? substitutePrerequisiteProjectPlaceholder(normalizedDefault, project)
      : null;
  }
  if (!Array.isArray(skillIds)) return null;
  if (hasIssueCruncherSkill(skillIds)) return buildIssueCruncherPrerequisiteCommand(project);
  if (hasQaSkill(skillIds)) return buildQaPrerequisiteCommand(project);
  if (hasImproveSkill(skillIds)) return buildImprovePrerequisiteCommand();
  return null;
}
