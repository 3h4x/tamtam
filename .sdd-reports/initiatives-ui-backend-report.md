# Initiatives UI Backend — Implementation Report

**Status:** Complete

## Files Changed

### New files
- `app/api/initiatives/route.ts` — GET all initiatives: flags, per-status counts, 200 most-recent rows (slim shape)
- `app/api/projects/by-project/[projectName]/initiatives/preview/route.ts` — GET live probe preview for a project (no persistence)
- `__tests__/api/initiatives-list.test.ts` — 4 PGlite tests: empty state, seeded counts, list shape, ordering
- `__tests__/api/initiatives-preview.test.ts` — 5 mocked tests: known project 200, unknown project 404, candidate shape, empty results

### Modified files
- `lib/orchestrator/initiatives-store.ts` — Added `listAllInitiatives(limit)` export (orders by updatedAt desc, reuses toRow)
- `__tests__/orchestrator/initiatives-store.test.ts` — Added 1 test for listAllInitiatives: ordering, limit, full row shape
- `docs/API.md` — Added GET /api/initiatives and GET /api/projects/by-project/[projectName]/initiatives/preview entries

## Test Results

pnpm test __tests__/orchestrator/initiatives-store.test.ts
  Test Files  1 passed (1)
  Tests  9 passed (9)

pnpm test __tests__/api/initiatives-list.test.ts
  Test Files  1 passed (1)
  Tests  4 passed (4)

pnpm test __tests__/api/initiatives-preview.test.ts
  Test Files  1 passed (1)
  Tests  5 passed (5)

Total: 18/18 passed

## Type-check and Lint

- pnpm type-check: PASS (no output)
- pnpm lint: PASS (no output)

## Notes

- listAllInitiatives is functionally identical to the existing listRecentInitiatives but exported under a new name for semantic clarity in the API route context.
- The preview route mocks runProbes and resolveProjectPath in tests per spec; the no-mock rule applies to DB only.
- GET /api/initiatives calls getSettings() directly (no initSettings() guard), matching neighbor route style.
