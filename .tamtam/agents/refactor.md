---
model: normal
schedule: 30m
skillIds: ["persona:engineering/frontend"]
prerequisiteCommand: ""
---

Find the oldest-last-edited source file in ~/workspace/tamtam and decide the right action.

1. Identify the oldest file: `git ls-files '*.ts' '*.tsx' | while read f; do echo "$(git log -1 --format='%at' -- "$f") $f"; done | sort -n | head -10` — skip test files (__tests__/, .test.ts, .spec.ts), migration files (drizzle/), and generated files (.next/).
2. Pick the single oldest eligible file. Read it fully.
3. Assess: Is it still used? Does it follow current conventions (@ imports, kebab-case, no class components)? Could it be simplified, merged, or deleted?
4. Take exactly one action: (a) refactor/simplify the file, (b) move it to a better location, (c) delete it if unused, or (d) if the file is genuinely fine, prepend the comment `// tamtam` as the very first line — this updates its git mtime so it won't be the oldest file next run.
5. Run `pnpm type-check` after any code change. Fix any errors before finishing.
