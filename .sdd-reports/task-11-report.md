# Task 11 Report — Documentation Edits

## Status
✓ COMPLETE

## Files Changed
1. `docs/ORCHESTRATOR.md` — Added "## Initiative Engine" section
2. `docs/DATABASE.md` — Added `initiatives` table documentation
3. `CLAUDE.md` — Added one-line Key Patterns note under Retention

## Changes Summary

### docs/ORCHESTRATOR.md
- New section placed after Autopilot, before "Signals the orchestrator computes"
- Documented engine adds mine + dispatch phases after autopilot, gated behind `initiative_engine_enabled` (default off)
- Explained Miner (probes → backlog), Dispatcher (serialized + ships/day-capped + drives release pipeline)
- Described scoring (severity + decay per attempts), per-project serialization, global gates reuse
- Noted charter + PM layer deferred to Phase 2
- Cross-linked to `docs/PIPELINE.md` and the spec at `docs/superpowers/specs/2026-06-20-initiative-engine-design.md`

### docs/DATABASE.md
- Inserted new `initiatives` table documentation after `queued_terminal_runs` section
- Documented columns: id, project, source, kind, title, rationale, prompt, score, status, dedup_key, release_id, attempts, cooldown_until, created_at, updated_at
- Explained status lifecycle: `proposed → queued → running → shipped|failed` (with `rejected`/`superseded` reserved)
- Described unique `(project, dedup_key)` constraint
- Noted defaults and nullability per column

### CLAUDE.md
- Added single bullet under Key Patterns (between Retention and Singletons)
- One-line summary: grounded Miner + serialized dispatcher as default-off orchestrator-tick phases discovering chores through release pipeline
- Cross-linked to `docs/ORCHESTRATOR.md`

All three edits follow existing doc style and formatting conventions.
