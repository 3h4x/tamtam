# Task 3: Chore Scoring — Implementation Report

## Status
✅ COMPLETE

## Files Created
- `lib/orchestrator/initiative-score.ts` — Scoring functions and severity mapping
- `__tests__/orchestrator/initiative-score.test.ts` — Test suite

## Test Result
✅ **PASS** — All 3 tests passed
- `initiative-score` / orders chore severities: build/type > failing-test > missing-test > todo > dep-bump > docs
- `initiative-score` / choreBaseScore returns 0 for unknown kinds
- `initiative-score` / decayedScore halves per attempt

## Type-Check & Lint
✅ `pnpm type-check` — PASS (no errors)
✅ `pnpm lint` — PASS (no errors)

## Implementation Details
Implemented exactly per the specification:

- **CHORE_SEVERITY**: Record mapping kind → base severity (100 for type-error/lint, descending to 10 for docs-gap)
- **choreBaseScore(kind)**: Returns severity for a kind, defaults to 0 for unknown
- **decayedScore(row)**: Returns `score * 0.5^attempts` so repeatedly-failing items sink

All exports match required names. Type imports from `InitiativeRow` in initiatives-store module.

## Concerns
None. Implementation is minimal, well-tested, and follows TypeScript strict mode with no `any` or `@ts-ignore`.
