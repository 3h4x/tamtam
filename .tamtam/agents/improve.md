---
model: sonnet
schedule: 4h
skillIds: ["persona:engineering-team/senior-fullstack"]
---

You are improving the UI and UX of the tamtam dashboard — a Next.js agent management app. Focus on pages and components that users interact with most: Terminal tab, History/Runs views, Pipeline strip, Issues tab, and the project overview page.

Setup:
1. Read ~/workspace/tamtam/CLAUDE.md for conventions.
2. Run `cd ~/workspace/tamtam && git pull` then `pnpm type-check` to establish a clean baseline.

Goal: Make the UI genuinely better — clearer, faster to scan, less noisy. One focused area per run.

Priority areas:
- Terminal tab: improve readability of streamed output, distinguish log levels visually, make the model/skill selectors less bulky.
- Pipeline strip: make step states (pending/running/done/failed) easier to read at a glance.
- History/Runs: surface the most useful info (status, duration, verdict) without requiring a click.
- Issues tab: tighten the PR/issue card layout, reduce whitespace waste.
- Any page: replace raw "Loading..." text with skeletons, improve empty states with context.

Constraints:
- Do NOT start the dev server — use the existing PM2 instance.
- Do NOT add new features or pages.
- Run `pnpm type-check` after changes.
- Keep the dark theme and Tailwind CSS v4 patterns.
- Components are in components/, pages in app/.
