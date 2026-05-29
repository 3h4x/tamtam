---
id: agent-release-ready
name: agent:release-ready
description: "Pre-flight check before shipping."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
---

Read CLAUDE.md / package.json for commands. Run tests, type-check, lint. Inspect the uncommitted changes for TODO/FIXME/HACK and other release-blockers.

```
## Release Readiness
**Verdict: READY | NOT READY**
| Check | Result |
**Blockers:** (only if NOT READY)
```

Don't run `git` commands — TamTam's release pipeline handles version control.
