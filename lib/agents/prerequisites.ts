export const ISSUE_CRUNCHER_SKILL_ID = 'agent-issue-cruncher';
export const IMPROVE_SKILL_ID = 'agent-improve';
export const QA_SKILL_ID = 'agent-qa';

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

// agent:qa prereq — resolves the QA target (qa_url / website) from the
// TamTam config service on the host *before* the agent starts, so the agent
// itself never has to reach back to localhost:1337. Browser-broker containers
// can't see the host's loopback, so a curl from inside the agent fails with
// "connection refused" — but the prereq runs on the host where the API is
// reachable, and its stdout is injected into the prompt verbatim.
export function buildQaPrerequisiteCommand(projectName: string): string {
  const url = `http://localhost:1337/api/projects/by-project/${encodeURIComponent(projectName)}/config`;
  return (
    `echo '## QA target config (resolved by prereq — do NOT re-curl)'; ` +
    `curl -fsS "${url}" 2>/dev/null ` +
    `|| echo '{"error":"tamtam config service unreachable from host"}'`
  );
}

// agent:improve prereq — runs in the project cwd. Outputs the top 5
// least-recently-modified candidate source files and the tail of the
// per-project audit log so the agent can skip files it already touched.
//
// Uses `git ls-files` (not `find`) so it lists tracked files plus untracked
// files that are not ignored by the project's own git excludes. Git submodules
// show up as a single gitlink entry, not their internal files, which keeps the
// candidate set inside "our code" even when projects vendor large dependencies
// (e.g. Solidity repos under `lib/`). Portable across macOS (BSD stat) and
// Linux (GNU stat).
//
// Audit log lives under `.tamtam/cache/audits/<agent>.md`. The `cache/` subdir
// is gitignored by default via `lib/agents/agent-memory.ts:ensureTamtamCacheGitignore`.
export const IMPROVE_AUDIT_PATH = '.tamtam/cache/audits/improve.md';

export function buildImprovePrerequisiteCommand(): string {
  // Skip generated, snapshot/fixture, report, and historical-archive files so
  // the candidate list points at code the agent can actually improve. See
  // tests for the full exclusion list rationale.
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
  if (hasQaSkill(skillIds)) return buildQaPrerequisiteCommand(project);
  if (hasImproveSkill(skillIds)) return buildImprovePrerequisiteCommand();
  return null;
}
