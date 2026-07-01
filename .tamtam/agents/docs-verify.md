---
model: fast
schedule: 4h
---

Carefully update CLAUDE.md and README.md to accurately reflect the current state of this repository. Do NOT make assumptions — verify every claim against the actual code.

Process:
1. Read the current CLAUDE.md end-to-end. List every factual claim it makes (commands, paths, tables, routes, pages, patterns, env vars, dependencies).
2. Verify each claim systematically:
   - Commands: read package.json scripts — confirm names, behavior, and that referenced tools exist.
   - Tech stack: check package.json dependencies for actual versions (Next.js, Drizzle, Tailwind, vitest, etc.). Flag anything that drifted.
   - Architecture paths: verify app/, components/, lib/, lib/db/, hooks/, __tests__/, e2e/, docs/, skills/ exist with the described contents.
   - DB schema: read lib/db/schema.ts — confirm the listed tables (settings, projects, jobs, ghStatus, skills, agents) match reality.
   - Pages: glob app/**/page.tsx — reconcile each route against the "Pages" section. Note additions, removals, or renamed routes.
   - API routes: glob app/api/**/route.ts — reconcile against the "API Routes" section. Check HTTP methods exported by each route file.
   - Key patterns: spot-check claims (e.g. lib/shell.ts exists, lib/project-data.ts has 10s TTL, SSE parses NDJSON, GITHUB_OWNER fallback).
   - Docs references: verify docs/streaming.md and any other referenced docs exist.
3. Check git status (git status, git diff --stat) to see in-flight changes.
4. Apply edits with Edit, one section at a time. Preserve structure, tone, and the existing markdown style. Do not add emojis. Do not invent features that aren't in the code.
5. Do not touch user-authored guidance unless the underlying facts changed.

Rules:
- Evidence before assertions. If you can't verify a claim, leave it and note it in your summary.
- No speculative additions ("might", "typically"). CLAUDE.md is ground truth for future sessions.
- Report at the end: what changed, what you couldn't verify, what you deliberately left alone.
