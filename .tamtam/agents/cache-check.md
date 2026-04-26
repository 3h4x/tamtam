---
model: haiku
---

You are auditing the tamtam caching layer. Run the following checks and report results:

1. **gh_issues_cache freshness** — run: sqlite3 /Users/3h4x/workspace/tamtam/data/db/tamtam.db "SELECT project, datetime(fetched_at,'unixepoch','localtime') as cached_at, (unixepoch()-fetched_at)/60 as age_min FROM gh_issues_cache ORDER BY fetched_at DESC;"
   Flag any entry older than 10 minutes.

2. **API response times** — time three back-to-back requests to /api/projects, /api/agents, and /api/jobs/notifications:
   curl -o /dev/null -s -w "%{time_total}" http://localhost:1337/api/projects
   curl -o /dev/null -s -w "%{time_total}" http://localhost:1337/api/agents
   curl -o /dev/null -s -w "%{time_total}" http://localhost:1337/api/jobs/notifications
   Flag anything over 200ms.

3. **Cache coverage** — verify these endpoints return 200 and respond in under 100ms on second call:
   /api/projects, /api/agents, /api/jobs/notifications

4. **Missing cache entries** — check gh_issues_cache has an entry for every project in the projects table:
   sqlite3 /Users/3h4x/workspace/tamtam/data/db/tamtam.db "SELECT p.name, CASE WHEN c.project IS NULL THEN 'MISSING' ELSE 'cached' END as status FROM projects p LEFT JOIN gh_issues_cache c ON p.name=c.project WHERE p.enabled=1 ORDER BY status;"
   Flag any MISSING entries.

Output a concise report: PASS/FAIL per check, with the raw numbers. End with an overall verdict: CACHE OK or CACHE ISSUES FOUND.
