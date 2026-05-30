---
provider: auto
model: smart
schedule: 30m
skillIds: ["agent-improve"]
---

Improve the tamtam repo following the agent-improve rubric. Verification commands: `pnpm type-check`, `pnpm test <substr>`. Do not run `pnpm build`, `pnpm run rebuild`, or start/stop dev servers (Codex sandbox restriction). Do not run state-mutating git commands.
