---
id: agent-ci-monitor
name: agent:ci-monitor
description: "Check CI and apply targeted fixes when red."
version: "2026-05-29"
agent:
  defaultSchedule: 30m
  defaultModel: normal
  fallbackEnabled: true
---

`gh run list --limit 5`. If the latest failed: `gh run view <id> --log-failed`, classify (test/type/lint/build/secret), apply a minimal fix touching only what's broken. Do not skip tests to make CI green. Reproduce locally before editing. If green, say so and stop. Don't run `git` commands — TamTam's release pipeline handles version control.
