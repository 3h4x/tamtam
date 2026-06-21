# Task 1 Report: `initiatives` table + migration

**Status:** DONE_WITH_CONCERNS

## Files Created / Modified

- **Modified:** `lib/db/schema.ts` — added `initiatives` table after the `recommendations` table block (~line 143). `serial` and `uniqueIndex` were already imported; no import changes needed.
- **Created:** `lib/db/migrations/0025_add_initiatives.sql` — hand-written migration SQL matching the plan exactly.
- **Modified:** `lib/db/migrations/meta/_journal.json` — appended entry `idx: 25`, tag `0025_add_initiatives`, `when: 1780600000000`.
- **Created:** `__tests__/db/initiatives-schema.test.ts` — schema test with 2 cases (defaults + unique constraint).

## Test Result

`pnpm test __tests__/db/initiatives-schema.test.ts` → **2 passed (2)** ✓

## Concerns

1. **Test code differs from the plan's template.** The plan's test used `const { db, cleanup } = await createTestPgDbEmpty()` which does not match the `TestDbHandle` interface in this codebase (it exposes `handle.db` and `handle[Symbol.asyncDispose]()`). Adapted the test to the actual API.

2. **PGlite multi-statement DDL.** The plan's sample DDL ran `CREATE TABLE` and `CREATE UNIQUE INDEX` as one `execute()` call. PGlite rejects multi-statement prepared statements. Split into two separate `execute()` calls.

3. **`createTestPgDbEmpty` boots with no tables.** The test must apply DDL inline before exercising the schema. This is consistent with how other tests in the codebase work (e.g., `durable-agent-run-slot.test.ts`), but diverges from the plan's assumption that the empty DB would already have the table.

## Migration applied to live DB

`pnpm db:migrate` completed successfully — the `initiatives` table and unique index now exist in the live Postgres instance.
