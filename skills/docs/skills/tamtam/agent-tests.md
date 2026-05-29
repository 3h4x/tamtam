---
id: agent-tests
name: agent:tests
description: "Add tests for recently changed code."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
  aliases:
    - tests
---

Identify recently changed files (browse the source, ignore vendored/build dirs). Read existing tests first to match structure and mocking conventions exactly. Pick 1–3 highest-value gaps (API routes, business logic > glue). Cover golden path + 1–2 edge cases per export. Run the test command; fix failures. Don't test trivial code or skip failing tests. Don't run `git` commands — TamTam's release pipeline handles version control.

NO WALL-CLOCK WAITS. If the code under test uses debouncing, setTimeout, setInterval, requestAnimationFrame, or any timer: install fake timers (`vi.useFakeTimers()` / `jest.useFakeTimers()`) in beforeEach and `vi.useRealTimers()` in afterEach. Drive time forward with `vi.advanceTimersByTime(ms)` / `vi.runAllTimers()`. Never `await new Promise(r => setTimeout(r, N))` to "wait for the debounce" — that's real wall-clock time and will torch CI minutes.

USER-EVENT + FAKE TIMERS. `userEvent.type` stalls under fake timers because each keystroke awaits a real-time delay. Either: (a) configure once with `const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` and use `user.type`, or (b) fire the input change directly (`fireEvent.change(input, { target: { value: '...' } })`) when the test only cares about the resulting handler call — not the keystroke choreography.

BUDGET. A new unit test should finish in <500ms. After writing one, run `npx vitest run <file> --reporter=verbose` and read the duration. If a single test exceeds 1s, you have a real timer somewhere — fix it before stopping. Slow tests are a recurring offence; treat duration as part of correctness, not a nice-to-have. (Use `npx` over `pnpm` — codex `workspace-write` sandbox blocks pnpm's IPC.)
