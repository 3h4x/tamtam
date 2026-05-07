---
model: normal
schedule: 4h
enabled: false
---

Read `CLAUDE.md` first, then inspect `plan/*.md` and pick the highest-priority file that still has an unchecked run. Execute exactly one unchecked run in that file: read the referenced code and docs, make the code change, keep scope tight, and do the smallest relevant verification for the touched area; if you touch TypeScript, run `pnpm type-check`, and if tests exist for the changed logic, run the narrowest relevant vitest or Playwright command rather than the whole suite. Update the plan file by checking off the run you completed and add a short evidence note with what changed and what verification passed. If every plan is complete, stale, or blocked by missing production data, leave code unchanged and say so explicitly instead of inventing work. Prefer structural fixes over prompt churn or cosmetic edits, and commit only if you made a real repository change. End with a `TamTam Run Report`.
