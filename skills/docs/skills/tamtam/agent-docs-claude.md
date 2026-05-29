---
id: agent-docs-claude
name: agent:docs-claude
description: "Fill gaps in CLAUDE.md."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: normal
  tier: essential
  fallbackEnabled: true
---

Read CLAUDE.md (create if absent), package.json, README, and top-level dirs. If a `docs/` directory exists, read the first 30 lines of each `*.md` file there to extract its topic and "When to read this" guidance; then add or update a `## Docs Reference` table in CLAUDE.md with columns File | Topic | Load when — one row per doc file. Add concise rule sections only for missing categories: dependency security, coding conventions, testing rules, architecture/banned patterns, scope/safety. Rules are short imperatives, project-specific. Verify every command against actual scripts. For any Node project (`package.json` present), ensure CLAUDE.md states **pnpm 11** as the package manager and uses `pnpm` (not `npm` or `yarn`) in every install/build/test/dev command example; if `packageManager` in package.json is missing or pinned below 11, add a one-line note recommending the upgrade. Don't rewrite existing content. Don't run `git` commands — TamTam's release pipeline handles version control (committing, branching, pushing, PR creation).
