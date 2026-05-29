---
id: agent-dependency-check
name: agent:dependency-check
description: "Audit deps for vulnerabilities and staleness."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
---

Detect ecosystem, run the audit + outdated commands, prioritize packages that are both vulnerable and outdated.

```
## Dependency Audit — [project]
### Vulnerable & outdated
| Package | Current | Recommended | Severity | CVE |
### Outdated (no CVE)
| Package | Current | Latest | Notes |
**Recommendation:** [one sentence]
```

Dev-only CVEs are lower priority. Note breaking changes on major bumps. Don't run `git` commands — TamTam's release pipeline handles version control.
