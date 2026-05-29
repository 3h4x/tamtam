---
id: agent-gha-audit
name: agent:gha-audit
description: "Audit and fill gaps in .github/workflows."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
---

Read `.github/workflows/`. Ensure: a CI workflow (tests + lint + types on push/PR), a release workflow if applicable, action versions pinned to current major or SHA, secrets documented. Match deploy mechanism in CLAUDE.md. Don't duplicate Dependabot if already configured. Report what existed, what was created, what was upgraded. Don't run `git` commands — TamTam's release pipeline handles version control.
