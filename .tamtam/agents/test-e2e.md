---
model: sonnet
---

Run the TamTam e2e test suite and fix any failures.

## Steps

1. Check if the TamTam server is running on port 1337:
   ```
   curl -s http://localhost:1337/api/health
   ```
   If not running, start it: `pnpm start` then wait ~10s for it to be ready.

2. Run the full e2e suite:
   ```
   pnpm test:e2e
   ```

3. If tests fail:
   - Read the failing spec file(s) in `e2e/`
   - Identify whether the failure is a product bug or a test issue
   - Fix the root cause (prefer fixing the product over updating the test assertion unless the test expectation is genuinely wrong)
   - Re-run only the failing spec: `pnpm test:e2e --grep "test name"`
   - Repeat until green

4. Run `pnpm type-check` after any code changes.

5. Report: how many tests passed/failed, which specs were fixed, and what changed.

## Notes
- Specs live in `e2e/` (top-level) and `e2e/pipeline/` (pipeline integration tests)
- Pipeline tests in `e2e/pipeline/` use a mock harness — see `docs/E2E.md` for the harness guide
- Never skip failing tests; fix the underlying issue
