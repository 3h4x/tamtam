export {
  IMPROVE_AUDIT_PATH,
  IMPROVE_LEDGER_PATH,
  IMPROVE_SKILL_ID,
  ISSUE_CRUNCHER_SKILL_ID,
  QA_SKILL_ID,
} from '@/lib/agents/skill-ids';
import {
  IMPROVE_AUDIT_PATH,
  IMPROVE_LEDGER_PATH,
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

export function parsePrerequisiteCommandInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  // null means "no explicit override — inherit the skill/template default".
  // Coercing it to '' would persist an explicit empty override that both
  // dirties the committed .md file and suppresses the skill's default prereq.
  if (value === null) return null;
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
  // Candidate selection is content-addressed, not mtime-based:
  //   1. Tracked and non-ignored untracked candidates are both hashed with
  //      `git hash-object`, so the ledger key always reflects current bytes.
  //   2. A single `git log` pass gives tracked files' latest-commit time. Untracked
  //      files have no commit time, so they sort as oldest and get audited promptly.
  //   3. Any file whose current blob SHA is already in the ledger is skipped, so a
  //      file re-surfaces only when its bytes change. No `touch`, no deadlock on
  //      files the agent audits-but-cannot-edit (it records them in the ledger and
  //      moves on). When every file is audited at its current content, the agent idles.
  const ledger = IMPROVE_LEDGER_PATH;
  const ageTmp = '.tamtam/cache/audits/.improve-age.tmp';
  const candTmp = '.tamtam/cache/audits/.improve-cand.tmp';
  const select =
    `mkdir -p .tamtam/cache/audits; : >> ${ledger}; ` +
    // path -> latest commit epoch (single history pass; first-seen = newest commit)
    `git log --format='@%ct' --name-only --no-renames 2>/dev/null ` +
    `| awk '/^@/{t=substr($0,2);next} NF&&!seen[$0]++{age[$0]=t} END{for(p in age)print age[p]"\\t"p}' ` +
    `> ${ageTmp}; ` +
    // tracked candidates + current blob SHA, minus generated/vendored/archive paths and ledger hits
    `git ls-files 2>/dev/null | while IFS= read -r path; do ` +
    `case "$path" in ` +
    `*.ts|*.tsx|*.js|*.jsx|*.sol|*.py|*.rs|*.go|*.md|*.sh) ;; *) continue;; ` +
    `esac; ` +
    `case "$path" in ` +
    `*.d.ts|*.gen.*|*.generated.*) continue;; ` +
    `.tamtam/*|*/.tamtam/*|node_modules/*|*/node_modules/*) continue;; ` +
    `*__snapshots__/*|*__fixtures__/*|*/fixtures/*|*/test-results/*|*/playwright-report/*|*/coverage/*|*/dist/*|*/build/*|*/out/*) continue;; ` +
    `docs/superpowers/plans/*|docs/superpowers/specs/*) continue;; ` +
    `CHANGELOG.md|LICENSE|LICENSE.md|LICENCE|LICENCE.md) continue;; ` +
    `esac; ` +
    `sha=$(git hash-object -- "$path" 2>/dev/null) || continue; ` +
    `[ -n "$sha" ] || continue; ` +
    `grep -qxF "$sha" ${ledger} 2>/dev/null && continue; ` +
    `printf '%s\\t%s\\n' "$sha" "$path"; ` +
    `done > ${candTmp}; ` +
    // non-ignored untracked candidates get the same git-blob hash shape
    `git ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r path; do ` +
    `case "$path" in ` +
    `*.ts|*.tsx|*.js|*.jsx|*.sol|*.py|*.rs|*.go|*.md|*.sh) ;; *) continue;; ` +
    `esac; ` +
    `case "$path" in ` +
    `*.d.ts|*.gen.*|*.generated.*) continue;; ` +
    `.tamtam/*|*/.tamtam/*|node_modules/*|*/node_modules/*) continue;; ` +
    `*__snapshots__/*|*__fixtures__/*|*/fixtures/*|*/test-results/*|*/playwright-report/*|*/coverage/*|*/dist/*|*/build/*|*/out/*) continue;; ` +
    `docs/superpowers/plans/*|docs/superpowers/specs/*) continue;; ` +
    `CHANGELOG.md|LICENSE|LICENSE.md|LICENCE|LICENCE.md) continue;; ` +
    `esac; ` +
    `sha=$(git hash-object -- "$path" 2>/dev/null) || continue; ` +
    `[ -n "$sha" ] || continue; ` +
    `grep -qxF "$sha" ${ledger} 2>/dev/null && continue; ` +
    `printf '%s\\t%s\\n' "$sha" "$path"; ` +
    `done >> ${candTmp}; ` +
    // join age onto candidates (missing age = 0 = oldest), oldest-first, take 5
    `out=$(awk -F'\\t' 'BEGIN{first=ARGV[1]} FILENAME==first{age[$2]=$1;next}{a=age[$2];if(a=="")a=0;print a"\\t"$2"\\t"$1}' ${ageTmp} ${candTmp} ` +
    `| sort -n | head -5 | awk -F'\\t' '{printf "%s  (blob %s)\\n",$2,$3}'); ` +
    `rm -f ${ageTmp} ${candTmp}; ` +
    `if [ -n "$out" ]; then printf '%s\\n' "$out"; ` +
    `else echo '(all tracked and non-ignored untracked files audited at current content — idle until a file changes)'; fi`;
  return (
    `echo '## Next 5 unaudited candidates (oldest commit first, current content)'; ${select}; ` +
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
