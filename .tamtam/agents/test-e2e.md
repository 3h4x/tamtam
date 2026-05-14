---
model: normal
schedule: 1h
---

Your goal is to improve TamTam's UI by writing and running Playwright tests that exercise job lifecycle transitions against a mocked backend — never against the production server on port 1337.

## Context

TamTam already has a mocked test harness in `e2e/pipeline/`:
- `playwright.pipeline.config.ts` — spins up Next.js on **port 1338** with `DATABASE_URL` pointing to an isolated Postgres database (`tamtam_e2e_pipeline` by default; override via `E2E_DATABASE_URL`)
- `e2e/pipeline/global-setup.ts` — seeds fake git repos, installs shim binaries (claude, git, gh) that intercept real calls
- `e2e/pipeline/helpers.ts` — `writeScenario()` scripts Claude output; `readShimCalls()` asserts git/gh calls
- `e2e/pipeline/mocks/` — shim binaries for claude, git, gh

Read all of the above before writing any tests.

## What to test

Focus on **job lifecycle UI transitions** — scenarios where the UI must correctly reflect backend state changes:

1. **Job starts → spinner shows in runs list and terminal**
2. **Job completes (success) → status updates without page reload**
3. **Job is cancelled mid-run → status shows cancelled, no orphaned spinner**
4. **Job fails (exit code != 0) → failure badge + error message visible**
5. **Pipeline strip** — each step (test → review → fix → commit → push) transitions correctly; strip disappears when done
6. **Concurrent jobs** — two jobs running simultaneously; both show correct independent state
7. **Jobs paused** — UI reflects paused state; release button is disabled

For each scenario you implement, write a Playwright spec that:
1. Uses the port 1338 test server (never 1337)
2. Uses `page.route()` to mock API responses OR uses `writeScenario()` to control shim behavior
3. Asserts the specific UI element that should change (aria label, text, class, visibility)
4. Is deterministic — no arbitrary `page.waitForTimeout()`; use `waitForSelector` or API polling with retries

## Workflow

1. Read `docs/E2E.md` for the full harness guide.
2. Read existing specs in `e2e/pipeline/` to understand established patterns.
3. Pick the 1–2 highest-value gaps from the list above that don't have coverage yet.
4. Write the spec(s) in `e2e/pipeline/` (pipeline tests) or `e2e/` (UI-only tests with `page.route()`).
5. Run with `pnpm exec playwright test --config=playwright.pipeline.config.ts <spec-file>`.
6. Fix failures — if a test reveals a real UI bug, fix the component too.
7. After green, check if the fix or new scenario exposes any improvement opportunity in the UI (loading states, error messages, empty states). If yes, implement it.

## Rules
- Never add `waitForTimeout`. Use proper selectors and retry-based waits.
- Never test against port 1337.
- Don't mock what you can shim — prefer the shim approach for server-side behavior.
- Don't skip failing tests; fix the root cause.
- Run `pnpm type-check` after any component changes.
