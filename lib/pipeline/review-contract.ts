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

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ParsedFinding {
  id: string;
  severity: FindingSeverity | null;
  rootCause: string | null;
  affectedPaths: string | null;
  requiredFix: string | null;
  requiredTests: string | null;
}

const findingFieldKeys = [
  'severity',
  'root cause',
  'affected paths',
  'documentation',
  'required fix',
  'required tests',
  'verification',
] as const;

// Walk a parsed (text-only) review log and pull out structured Finding blocks
// matching the REVIEW_OUTPUT_CONTRACT shape. Returns the de-duplicated list in
// the order they first appear; later restatements of the same Finding ID
// (common when reviews loop) are merged keeping the first non-empty value
// for each field.
export function parseFindings(text: string): ParsedFinding[] {
  const lines = text.split(/\r?\n/);
  const findings = new Map<string, ParsedFinding>();
  const order: string[] = [];
  const idRe = /^\s*[-*]?\s*Finding ID:\s*([a-z0-9][a-z0-9._/-]*)\s*$/i;
  const fieldRe = /^\s*([A-Za-z][A-Za-z ]+):\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(idRe);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const fields: Record<string, string> = {};
    let lastKey: string | null = null;

    // Read fields until the next Finding ID, an empty section break, or the
    // verdict line. Continuation lines (indented further than the field
    // marker) append to the previous field — matches the contract's
    // multi-line "Root cause" / "Required fix" usage.
    for (let j = i + 1; j < lines.length; j++) {
      if (idRe.test(lines[j])) break;
      if (/^\s*Verdict\s*:/i.test(lines[j])) break;
      if (/^\s*Findings\s*:/i.test(lines[j])) break;
      const fm = lines[j].match(fieldRe);
      if (fm) {
        const key = fm[1].trim().toLowerCase();
        if ((findingFieldKeys as readonly string[]).includes(key)) {
          fields[key] = fm[2].trim();
          lastKey = key;
          continue;
        }
        // Unknown field name with a colon — could be a wrapped "files:line: ..."
        // continuation. Append to the previous field if any.
        if (lastKey) fields[lastKey] = `${fields[lastKey]} ${lines[j].trim()}`.trim();
        continue;
      }
      const trimmed = lines[j].trim();
      if (!trimmed) {
        // Blank line: end the current finding only if we've already collected
        // at least one field; otherwise tolerate it (contract examples have
        // blanks between findings).
        if (lastKey) break;
        continue;
      }
      if (lastKey) fields[lastKey] = `${fields[lastKey]} ${trimmed}`.trim();
    }

    const severity = (fields['severity'] || '').toLowerCase();
    const finding: ParsedFinding = {
      id,
      severity: (['low', 'medium', 'high', 'critical'] as const).includes(severity as FindingSeverity)
        ? (severity as FindingSeverity)
        : null,
      rootCause: fields['root cause'] || null,
      affectedPaths: fields['affected paths'] || null,
      requiredFix: fields['required fix'] || null,
      requiredTests: fields['required tests'] || null,
    };
    if (!findings.has(id)) {
      findings.set(id, finding);
      order.push(id);
    } else {
      // Merge: keep first non-empty value per field.
      const existing = findings.get(id)!;
      const merged: ParsedFinding = {
        id,
        severity: existing.severity ?? finding.severity,
        rootCause: existing.rootCause ?? finding.rootCause,
        affectedPaths: existing.affectedPaths ?? finding.affectedPaths,
        requiredFix: existing.requiredFix ?? finding.requiredFix,
        requiredTests: existing.requiredTests ?? finding.requiredTests,
      };
      findings.set(id, merged);
    }
  }
  return order.map((id) => findings.get(id)!);
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
