---
model: sonnet
schedule: 1h
skillIds: ["persona:engineering/fullstack"]
---

You are improving the UI and UX of the TamTam dashboard, a Next.js agent management app.

Goal: Review the least recently changed user-facing UI file and make one focused improvement to that area. Improve, refactor, or delete code when it is demonstrably unused. Do not browse the whole app looking for generic polish opportunities.

Setup:
1. Read `CLAUDE.md` for conventions.
2. Run `git pull`.
3. Run `pnpm type-check` to establish a clean baseline.

Selection rule:
1. Identify user-facing files under `components/` or `app/`.
2. For each candidate, look for a `// last-viewed-by-tamtam: YYYY-MM-DD` marker on the first non-empty line of the file (placed above `'use client'` if present).
3. Sort: files without a marker first, then files with the oldest marker date. Tiebreak by least recently changed in git history.
4. Choose the first relevant UI file from that list.
5. If the least recently changed file is not directly UI-facing, choose the nearest related UI component that renders its behavior.
6. Work on that one area only.
7. After working on the file (even if no other edits were made), add or update the `// last-viewed-by-tamtam: YYYY-MM-DD` marker to today's date so the next run rotates away from it.

What to improve:
- Make the selected UI clearer, faster to scan, or less noisy.
- Prefer small refactors that improve structure, naming, layout density, state clarity, or repeated UI patterns.
- Delete dead UI code only after verifying it has no imports, routes, tests, or runtime references.
- Improve loading, empty, error, running, success, and failed states if the selected component already has them.
- If the file relates to Terminal, Runs/History, Pipeline strip, Issues, or Project overview, use that product context. Do not touch those areas just because they are listed here.

Priority context:
- Terminal tab: readable streamed output, clearer log levels, less bulky selectors.
- Pipeline strip: clearer pending/running/done/failed states.
- History/Runs: status, duration, verdict visible without extra clicks.
- Issues tab: tighter PR/issue cards, less wasted whitespace.
- Project overview: clearer status, active work, and next action.
- Any page: replace raw `Loading...` text with skeletons and improve empty states with useful context.

Constraints:
- Do NOT start the dev server.
- Do NOT assume PM2 access. If runtime inspection is needed, first check whether the app is already reachable via the configured local URL or health endpoint. If it is not reachable, proceed with static code review and type-check only.
- Do NOT add new features, pages, routes, dependencies, or design systems.
- Keep the dark theme and Tailwind CSS v4 patterns.
- Follow existing component conventions.
- Keep the change small and focused.
- Run `pnpm type-check` after changes.
- Always update the `// last-viewed-by-tamtam: YYYY-MM-DD` marker on the selected file before finishing, so the rotation works even when no functional changes ship.
- Report the selected file, why it was selected, what changed, and the verification result.
