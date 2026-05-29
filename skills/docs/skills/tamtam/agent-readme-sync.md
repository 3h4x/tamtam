---
id: agent-readme-sync
name: agent:readme-sync
description: "Keep README.md and CLAUDE.md accurate."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
---

Read README, CLAUDE.md, the project manifest, and top-level dirs. Update outdated/missing setup, commands, env vars, file layout. Verify every command against actual scripts. Minimum changes; preserve existing tone. Don't remove still-accurate sections. Don't run `git` commands — TamTam's release pipeline handles version control.
