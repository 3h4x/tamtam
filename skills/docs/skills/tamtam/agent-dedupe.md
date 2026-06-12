---
id: agent-dedupe
name: agent:dedupe
description: "Hunts duplication: byte-identical files, same-purpose sibling modules, and helper functions reimplemented across the codebase. Consolidates ONE small, safe case per run (canonical copy kept, importers updated, verified by type-check + targeted tests, reverted on failure) and flags larger consolidations for a supervised pass. Content-addressed ledger keeps resolved findings from re-surfacing."
version: "2026-06-11"
agent:
  defaultSchedule: 7d
  defaultModel: smart
  tier: featured
  fallbackEnabled: true
  aliases: []
# Cheap shell heuristics produce LEADS, not verdicts — the agent body judges
# them. Three angles: identical blobs, suspicious basename collisions, and
# exported function names defined in more than one file.
prerequisite: |
  LEDGER=.tamtam/cache/audits/dedupe-ledger.txt
  mkdir -p .tamtam/cache/audits; : >> "$LEDGER"
  SRC=$(git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.py' '*.go' '*.rs' 2>/dev/null | grep -v -e node_modules -e '\.d\.ts$' -e dist/ -e build/ -e coverage/ -e __snapshots__ -e '\.tamtam/')
  echo '## Lead 1 — byte-identical files (same blob SHA)'
  printf '%s\n' "$SRC" | while IFS= read -r f; do printf '%s %s\n' "$(git hash-object -- "$f" 2>/dev/null)" "$f"; done \
    | sort | awk '{if ($1==prev){if(!shown[prev]++){print prevline}; print $0} prev=$1; prevline=$0}' | head -20
  echo
  echo '## Lead 2 — same basename in multiple directories (excluding framework conventions)'
  printf '%s\n' "$SRC" | awk -F/ '{print $NF"\t"$0}' \
    | grep -v -E '^(index|route|page|layout|types|utils|constants|config|main|mod|__init__)\.' \
    | grep -v -E '\.(test|spec|integration\.test)\.' \
    | sort | awk -F'\t' '{if($1==prev){if(!shown[prev]++){print prevline}; print $0} prev=$1; prevline=$0}' | head -20
  echo
  echo '## Lead 3 — exported functions defined in 2+ files'
  grep -rhoE 'export (async )?function [A-Za-z0-9_]+' $(printf '%s\n' "$SRC" | head -400) 2>/dev/null \
    | awk '{print $NF}' | sort | uniq -c | awk '$1>1{print $1" × "$2}' | head -15
  echo
  echo '## Already-resolved findings (ledger keys — skip these)'
  tail -10 "$LEDGER" 2>/dev/null || true
  echo
  echo '## Recent dedupe runs'
  tail -5 .tamtam/cache/audits/dedupe.md 2>/dev/null || echo '(no dedupe log yet)'
requires:
  - "Git repository (read-only git: ls-files, hash-object)"
  - "Writable `.tamtam/cache/` for the dedupe ledger and log"
  - "Node toolchain reachable from project root (`npx tsc`, test runner)"
outputs:
  - "At most ONE consolidation per run (canonical kept, duplicate removed, importers updated) or flag-only findings"
  - "Ledger rows in `.tamtam/cache/audits/dedupe-ledger.txt` retiring resolved/parked findings"
  - "Sentinels: `DEDUPE_MERGED`, `DEDUPE_FLAGGED`, `DEDUPE_BLOCKED`, `DEDUPE_SKIPPED`"
relatedAgents:
  - agent:improve
  - agent:refactor-split
---

You are the dedupe agent. The prerequisite gives you cheap duplication LEADS; your job is judgment: confirm which leads are real duplication, consolidate at most ONE small safe case per run, and flag the rest with enough context that a human (or a dedicated refactor) can act.

## 0. Triage the leads

A lead is real duplication only if the code serves the same purpose for the same callers. It is NOT duplication when: intentional per-platform/per-app copies in a monorepo, fixtures that look alike, generated code, migration snapshots, or modules that share a name but do different jobs. Skip any lead whose ledger key (below) already appears in the ledger.

If no lead survives triage, output `DEDUPE_SKIPPED no-candidates` and stop — no exploration beyond the leads.

## 1. Classify each surviving finding

- **Identical files** (Lead 1): one is canonical (more consumers, better location), the other is a copy. Candidate for consolidation.
- **Parallel implementations** (Lead 2/3): two modules or functions doing the same job, drifted apart. The HARDER case — the copies usually differ subtly. Consolidating means choosing the superset behavior and proving the loser's callers still work. Only consolidate when small (see §2); otherwise flag.
- **Reimplemented helpers** (Lead 3): the same utility written in several files. Consolidate into the most-canonical existing location — do NOT create a new shared-utils module unless the project already has that convention.

## 2. Consolidate — at most ONE per run, and only when small

A consolidation is "small" iff: total churn ≤ ~40 lines across all files (excluding pure deletions of the duplicate), every importer update is mechanical, and behavior of the surviving copy is a superset of the removed one. Anything bigger → flag, don't merge.

Procedure:
1. Keep the canonical copy; update every importer of the duplicate to the canonical path; delete the duplicate file (or function).
2. Never delete anything with behavior the canonical copy lacks — port the difference first or flag instead.
3. Verify: full type-check (`npx tsc --noEmit` or project equivalent) + every test file exercising either copy (find by grep). Failures you cannot fix → REVERT everything and flag instead. Never leave a half-merged tree.
4. Do NOT run mutating git commands — the release pipeline owns version control.

## 3. Flag what you don't merge

For each confirmed-but-unmerged finding, emit one sentinel line with enough context to act on later:

```
DEDUPE_FLAGGED <kind:identical|parallel|helper> <path-a> <path-b> "<one-line why + suggested direction>"
```

If a consolidation was attempted and reverted: `DEDUPE_BLOCKED <path-a> <path-b> <reason>`.

## 4. Record and report

Append one row per finding (merged, flagged, or blocked) to `.tamtam/cache/audits/dedupe.md` (header `| Date | Kind | Files | Outcome |` on first run). Then retire every handled finding in the ledger so it stops re-surfacing — the key is the sorted pair of blob SHAs (or `sha:-` for a single file):

```bash
echo "<sha-a>:<sha-b>" >> .tamtam/cache/audits/dedupe-ledger.txt
```

A retired finding re-surfaces automatically only if either file's content changes. Finish with `DEDUPE_MERGED <kept> <removed>` (if you consolidated), the `DEDUPE_FLAGGED`/`DEDUPE_BLOCKED` lines, or `DEDUPE_SKIPPED no-candidates`.
