export const REVIEW_OUTPUT_CONTRACT = `REVIEW METHOD — required:
- Review the changed behavior, not just the visible diff hunk.
- For validation, auth, permission, security, data-integrity, duplicate-detection, or canonicalization findings, complete this blast-radius checklist before writing the verdict:
  - client/UI entrypoints
  - server/API entrypoints
  - shared parsers/helpers
  - alternate routes or background jobs that can perform the same action
  - storage, canonicalization, and duplicate checks
  - tests covering every relevant entrypoint
- Documentation is part of the change contract. Check whether relevant committed documentation under docs/*.md needs to be created or updated. Require docs when the change alters architecture, pipeline behavior, API contracts, configuration, operational workflow, security model, or user-facing behavior. Do not require docs for trivial refactors, typo fixes, or changes whose behavior is already fully covered by existing docs.
- Do not stop at the first local symptom. Report the root cause and every sibling path you found.
- When this review follows a fix, first re-check every prior finding in this release before looking for new issues.

OUTPUT FORMAT — findings:
If there are findings, write them in this shape:

Findings:
- Finding ID: stable-kebab-case-id
  Severity: low | medium | high | critical
  Root cause: the invariant that is broken, not just the file/line symptom
  Affected paths: files, routes, commands, or workflows that share the broken invariant
  Documentation: required docs/*.md updates, or "not required" with a short reason
  Required fix: the implementation contract that must be satisfied
  Required tests: tests that must prove the fix across affected paths
  Verification: commands or checks you ran, or that the fixer must run

If there are no findings, write:

Findings: none`;

export const FIX_OUTPUT_CONTRACT = `FIX METHOD — required:
- Apply fixes for ALL findings, including any sibling paths named in Affected paths.
- Treat each finding as a root-cause contract. Search for equivalent client, server, alternate route, shared helper, storage, canonicalization, and test gaps before editing.
- Do not stop after changing the first referenced file if the same invariant exists elsewhere.
- Run the most relevant tests or linters you can.

FINAL RESPONSE FORMAT:
Fix checklist:
- Finding ID: <id or source job issue>
  Status: fixed | not fixed
  Files changed: <paths>
  Tests: <commands and result>
  Remaining risk: <none or concise note>`;

export function stripFinalVerdict(text: string): string {
  const trimmed = text.trim();
  const verdictMatch = trimmed.match(/\n?[ \t]*Verdict:[^\n]*\s*$/i);
  if (!verdictMatch) return trimmed;
  return trimmed.slice(0, verdictMatch.index).trimEnd();
}

export function extractFindingIds(text: string): string[] {
  const ids = new Set<string>();
  const pattern = /^\s*[-*]?\s*Finding ID:\s*([a-z0-9][a-z0-9._/-]*)\s*$/gim;
  for (const match of text.matchAll(pattern)) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids].sort();
}

export function findingsIdentity(text: string): string | null {
  const ids = extractFindingIds(text);
  if (ids.length === 0) return null;
  return ids.join('|');
}

export type FixClaim = { id: string; status: 'fixed' | 'not fixed' };

// Parse the Fix checklist emitted by fix jobs (per FIX_OUTPUT_CONTRACT). For
// each `Finding ID: X` line, look ahead up to 6 lines for `Status: fixed |
// not fixed`. A new `Finding ID:` line ends the lookahead window for the
// previous claim. Lines without a Status are dropped.
export function extractFixClaims(text: string): FixClaim[] {
  const lines = text.split(/\r?\n/);
  const idRe = /^\s*[-*]?\s*Finding ID:\s*([a-z0-9][a-z0-9._/-]*)\s*$/i;
  const statusRe = /^\s*[-*]?\s*Status:\s*(fixed|not fixed)\b/i;
  const claims: FixClaim[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(idRe);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const end = Math.min(lines.length, i + 7);
    for (let j = i + 1; j < end; j++) {
      if (idRe.test(lines[j])) break;
      const sm = lines[j].match(statusRe);
      if (sm) {
        const status = sm[1].toLowerCase() as 'fixed' | 'not fixed';
        const key = `${id}:${status}`;
        if (!seen.has(key)) {
          seen.add(key);
          claims.push({ id, status });
        }
        break;
      }
    }
  }
  return claims;
}
