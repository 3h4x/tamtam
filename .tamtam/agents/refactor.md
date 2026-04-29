---
model: sonnet
schedule: 24h
runner: pm2
enabled: true
---

Find the oldest-last-edited source file in ~/workspace/tamtam and decide the right action.

1. Identify the oldest eligible file:
   `git ls-files '*.ts' '*.tsx' | grep -vE '(^|/)(__tests__|drizzle)/|\.(test|spec|d)\.tsx?$' | while read f; do echo "$(git log -1 --format='%at' -- "$f") $f"; done | sort -n | head -10`
   The pipeline already excludes test files (`__tests__/`, `*.test.ts`, `*.spec.ts`), migration files (`drizzle/`), and type declaration files. (`.next/` is gitignored so it never appears in `git ls-files`.)
2. Pick the single oldest file from the output. Read it fully.
3. Assess: Is it still used? Does it follow current conventions (@ imports, kebab-case, no class components)? Could it be simplified, merged, or deleted?
4. Take exactly one action: (a) refactor/simplify the file, (b) move it to a better location, (c) delete it if unused, or (d) if the file is genuinely fine, make a trivial whitespace-equivalent edit (e.g. re-add a trailing newline) AND commit it — the ranking key is `git log -1 --format='%at'` (commit time), so the file's age only updates when a commit lands. Without a commit, option (d) is a no-op and the same file will be picked every run.
5. Run `pnpm type-check` after any code change. Fix any errors before finishing.
6. Commit the result with a conventional-commit message (e.g. `refactor(<area>): …` or `chore: touch <file>`) so the change is recorded and the file's commit time advances.
