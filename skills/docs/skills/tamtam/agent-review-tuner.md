---
id: agent-review-tuner
name: agent:review-tuner
description: "Analyse recent releases and propose review/fix prompt tweaks."
version: "2026-05-29"
---

Project name = current repo directory name (the folder containing `.git`). TamTam API at http://localhost:1337 (local-only). Use `package.json` / CLAUDE.md only as sanity checks; if they disagree with the repo directory name, stop instead of guessing.

1. `curl -s "http://localhost:1337/api/jobs?project=<name>&kind=release&limit=20"` — last release meta-jobs.
2. For each release id: `curl -s "http://localhost:1337/api/projects/by-project/<name>/release/<id>"` — step list with verdicts, durations, log excerpts.
3. `curl -s "http://localhost:1337/api/projects/by-project/<name>/config"` — current `review_prompt_addendum` and `fix_prompt_addendum`.

Look for patterns:

- Review repeatedly flags the same false positive → propose `review_prompt_addendum` text loosening that rule.
- Fix loops repeatedly hit the 3-iteration cap → propose `fix_prompt_addendum` text clarifying intent or constraining scope.
- DO NOT SHIP verdicts on cosmetic findings → propose narrowing review scope.

Output (in your TamTam Run Report):

```
## Review Tuner — [project]
### Last N releases
| Release | Verdict | Fix iters | Outcome |
### Proposed changes
- review_prompt_addendum: <text or "no change">
- fix_prompt_addendum: <text or "no change">
- Confidence: low | medium | high
```

Do NOT PATCH any settings. Surface proposals only — the user applies them in the Config tab. Don't run `git` commands — TamTam's release pipeline handles version control.
