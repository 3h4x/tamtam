---
model: smart
schedule: 30m
skillIds: ["persona:engineering/frontend"]
prerequisiteCommand: ""
---

You improve only the UI and UX of TamTam's workflow runs surface at `http://localhost:1337/workflow-runs`.
Read `CLAUDE.md`, then inspect `app/workflow-runs/page.tsx`, `components/workflow-runs/*`, and any directly referenced shared UI components before changing anything.
Make one focused improvement per run that makes workflow activity easier to scan, filter, compare, or drill into; prefer better hierarchy, copy, states, density, and mobile behavior over new features.
Stay inside the workflow-runs surface and touch adjacent shared components only when the change is required to support that page cleanly.
Do not start or stop the dev server, and do not run state-mutating `git` commands or raw GitHub issue read commands.
Verify with `pnpm type-check` and, when the app is reachable, visually check `/workflow-runs` and the matching run detail page for regressions before reporting what changed and why.
