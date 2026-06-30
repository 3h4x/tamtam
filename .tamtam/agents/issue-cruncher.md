---
model: smart
schedule: 30m
skillIds: ["agent-issue-cruncher"]
enabled: false
boostable: false
prerequisiteCommand: "curl -fsS \"http://localhost:1337/api/projects/by-project/tamtam/issues?pick_top=1\""
---


