---
model: normal
schedule: 1h
skillIds: ["persona:engineering/fullstack"]
enabled: false
---

You are improving the UI and UX of the TamTam dashboard, a Next.js agent management app.

Goal: pick the **most recently modified** user-facing UI file under `components/` or `app/` and make one focused improvement to that area. Improve, refactor, or delete unused code. Do not roam the app looking for generic polish.

Setup:
1. Read `CLAUDE.md` for conventions.
2. List candidate files by modification time (newest first): `ls -t components/**/*.tsx app/**/*.tsx` or `find components app -name '*.tsx' -printf '%T@ %p\n' | sort -rn | head`.

Selection rule:
1. Drop non-UI files (pure types, server-only configs, test files).
2. Pick the first relevant UI file from that newest-first list.
3. If the most recently modified file is not directly UI-facing, choose the nearest UI component that renders its behavior.
4. Work on that one area only.

What to improve:
- Make the selected UI clearer, faster to scan, or less noisy.
- Prefer small refactors that improve structure, naming, layout density, state clarity, or repeated UI patterns.
- Delete dead UI code only after verifying it has no imports, routes, tests, or runtime references.
- Improve loading, empty, error, running, success, and failed states if the selected component already has them.

Priority context (use only if the selected file already belongs to one of these areas):
- Terminal tab: readable streamed output, clearer log levels, less bulky selectors.
- Pipeline strip: clearer pending/running/done/failed states.
- History/Runs: status, duration, verdict visible without extra clicks.
- Issues tab: tighter PR/issue cards, less wasted whitespace.
- Project overview: clearer status, active work, and next action.
- Any page: replace raw `Loading...` text with skeletons and improve empty states with useful context.

Constraints:
- No state-mutating `git` — TamTam's release pipeline owns branch/commit/push/checkout/pull/merge/rebase/reset/tag/stash. Read-only `git log`/`diff`/`status`/`show` is fine if you need recent context.
- Do NOT start or stop the dev server — TamTam manages dev-server lifecycle via `dev_server_start_command`. Assume the configured server is reachable; otherwise proceed with static review only.
- Do NOT run `gh issue view`, `gh issue list`, `gh api repos/*/issues/*` — issue context is gated server-side by TamTam.
- Do NOT add new features, pages, routes, dependencies, or design systems.
- Match the styling already present in the file you're editing — do not impose a theme or token system the surrounding code isn't using.
- Keep the change small and focused.
- Report the selected file, why it was selected, what changed, and the verification result.
