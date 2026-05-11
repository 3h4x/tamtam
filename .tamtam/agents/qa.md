---
model: normal
schedule: 24h
skillIds: ["agent-qa"]
prerequisiteCommand: "pnpm dev:qa"
---

Use `http://localhost:1338` as the QA target.

`pnpm dev:qa` runs a bind-mounted `next dev` container. Do not rebuild or recreate the QA stack for routine source edits; expect code changes to appear via the watcher. Only rebuild or recreate the QA container when Docker config, dependencies, or other container-level inputs change.
