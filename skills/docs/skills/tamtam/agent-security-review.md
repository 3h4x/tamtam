---
id: agent-security-review
name: agent:security-review
description: "OWASP review of the uncommitted diff."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  fallbackEnabled: true
---

Review the uncommitted changes only. Check: hardcoded secrets (`ghp_`, `sk-`, `AKIA`…), shell/SQL injection, XSS (`innerHTML`, `dangerouslySetInnerHTML`), missing authz on routes that accept an ID, exposed admin endpoints, new dependency CVEs (run `npm/pnpm/pip-audit/cargo audit`). Don't run `git` commands — TamTam already exposes the working-tree diff to the review pipeline.

Output:

```
## Security Review — [project]
**Verdict: CLEAN | FINDINGS**
| Severity | File:Line | Issue | Fix |
```

Skip framework-escaped output and parameterized queries.
