---
model: smart
skillIds: ["agent-issue-cruncher"]
prerequisiteCommand: "curl -fsS \"http://localhost:1337/api/projects/by-project/$(basename \"$(git rev-parse --show-toplevel)\")/issues?trusted_only=1\" | jq '{ repo, issues: [.issues[] | { number, title, labels: [.labels[].name], assignees: [.assignees[].login], url, author: .author.login, body }] }'"
---

