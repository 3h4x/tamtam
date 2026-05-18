---
model: normal
schedule: 30m
enabled: false
prerequisiteCommand: ""
---

Identify the slowest meaningful tests in the current suite and optimize them one file at a time without changing test intent. Read `docs/TEST.md`, `src/test/setup.ts`, and the nearest related tests first so your fixes match the repo's mocking and cleanup patterns. Limit changes to test files unless a tiny non-behavioral seam in the subject code is required, and prefer fixes like fake timers, narrower fixtures, or removing accidental I/O. Re-run the touched test file after each change and keep `pnpm run type-check` passing before moving on. Do not add packages or convert real behavior into brittle overspecification just to save time.
