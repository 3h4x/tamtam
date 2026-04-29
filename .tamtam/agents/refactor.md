---
model: sonnet
schedule: 24h
---

Find the oldest-last-edited source file in ~/workspace/tamtam and decide the right action.

1. Identify the oldest file: `git ls-files '*.ts' '*.tsx' | while read f; do echo "$(git log -1 --format='%at' -- "$f") $f"; done | sort -n | head -10` — skip test files (__tests__/, .test.ts, .spec.ts), migration files (drizzle/), and generated files (.next/).
2. Pick the single oldest eligible file. Read it fully.
3. Assess: Is it still used? Does it follow current conventions (@ imports, kebab-case, no class components)? Could it be simplified, merged, or deleted?
4. Take exactly one action: (a) refactor/simplify the file, (b) move it to a better location, (c) delete it if unused, or (d) if the file is genuinely fine, make a minimal whitespace-only edit that actually changes the file (e.g. strip and re-add the trailing newline, or normalize trailing whitespace on one line). Do NOT add comments or marker lines — they accumulate noise.
5. Run `pnpm type-check` after any code change. Fix any errors before finishing.
6. Commit the result with a conventional-commit message (e.g. `refactor(<area>): …`, `chore(<area>): remove unused <file>`, or `chore: touch <file>` for option (d)). The ranking key is `git log -1 --format='%at'`, so the commit is what advances the file's age and prevents the same file from being picked next run. Without a commit, the loop is a no-op.
