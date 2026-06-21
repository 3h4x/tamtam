# Initiative Engine — Phase 1 progress ledger

Plan: docs/superpowers/plans/2026-06-20-initiative-engine-phase1.md
Mode: working-tree only, NO commits, NO branch (on master). Subagent-driven, adapted.

- Task 8b: COMPLETE — instrumentation-node.ts wires initiativeEngineEnabled/mineInitiatives/dispatchInitiatives (listEnabledProjects, resolveProjectPath, runProbes/admitProject, reconcile via getJob+probeJobStatus, dispatchTopInitiative, startInitiativeRun->releaseId). type-check+lint clean.
- Task 11 (docs): COMPLETE — ORCHESTRATOR.md "Initiative Engine" section, DATABASE.md initiatives table, CLAUDE.md Key Patterns line.
- PHASE 1 COMPLETE. All in working tree, NOT committed (per user). Engine default-off.
- FINAL REVIEW (opus): CHANGES_REQUIRED -> fixed. Critical: run-initiative read json.jobId but endpoint returns job_id -> fixed via extractJobId (reads job_id, fallback jobId). Important: stale-running backstop added (reconcile now/staleMs=2h marks orphaned running->failed to free dedupKey). run-initiative 6/6, reconcile 9/9. Full suite 41/41, type-check+lint clean.
- CAVEAT to verify at next rebuild: instrumentation initiativeEngineEnabled uses require('@/lib/shared/config') (sync, commonjs OK) — confirm Next resolves @/ alias in require like await import.
- Task 10b: COMPLETE — startInitiativeRun returns jobId (test 2/2); initiative-reconcile.ts (reconcileRunningInitiatives, running->shipped/failed via job status, releaseId holds jobId) test 6/6; type-check+lint clean.
- Task 10a: COMPLETE — initiative-outcome.ts (markInitiativeOutcome shipped/failed+6h cooldown, shipsTodayCount UTC-day). test 2/2, type-check+lint clean.
- Task 9: COMPLETE — run-initiative.ts (startInitiativeRun + RunInitiativeDeps). DEVIATION (good): defaultStartRun uses HTTP dispatch to /api/agents/{id}/run with {prompt} (finds first enabled user agent) instead of startInProcessAgentJob (which needs pre-made job row). Verified endpoint reads body.prompt+x-tamtam-trigger. test 2/2, type-check+lint clean. CONSTRAINT: project must have >=1 enabled user agent or run fails.
- Task 8a: COMPLETE — initiative-admit.ts (admitProject) + initiative-probes.ts (runProbes, lint+TODO). exec real sig = exec(cmd,args[],opts)=>{stdout,stderr,exitCode}, never throws. test 3/3, type-check+lint clean. (8b instrumentation wiring still deferred)
- Task 7: COMPLETE — tick deps initiativeEngineEnabled?/mineInitiatives?/dispatchInitiatives? + gated call block after autopilot; new test 3/3, full orchestrator suite 18 pass, type-check+lint clean.
- NOTE: Task 8 split — 8a=probes+admit (now), 8b=instrumentation wiring deferred until after Task 9+10 (avoids broken dynamic-import type-check).
- Task 6: COMPLETE — config.ts 4 keys (engine off, mining on, ships/day 3, backlog 50) in type+DEFAULTS+parse; DEFAULTS now exported; SETTINGS.md rows; also patched cli-bin.test.ts literal. test 1/1, type-check+lint clean.
- Task 5: COMPLETE — initiative-dispatch.ts (dispatchTopInitiative + DispatchDeps/DispatchResult); test 6/6, type-check+lint clean.
- Task 4: COMPLETE — initiative-miner.ts (mineCandidates + ProbeFinding/ProbeResults); test 2/2, type-check+lint clean.
- Task 3: COMPLETE — initiative-score.ts (CHORE_SEVERITY/choreBaseScore/decayedScore); test 3/3, type-check+lint clean.
- Task 2: COMPLETE — initiatives-store.ts (upsertCandidate/listByStatus/listQueued/setStatus); test 4/4, type-check+lint clean.
- Task 1: COMPLETE — initiatives table + migration 0025 applied to live DB; test 2/2 pass. (schema.ts, migrations/0025_add_initiatives.sql, _journal.json idx25, __tests__/db/initiatives-schema.test.ts)

## Goal 2: Orchestrator visible in /stats — COMPLETE
- Backend: GET /api/stats/orchestrator (flags, initiative counts/shippedToday/recent, 24h actions boost/autopilot/health + recent). store helpers countByStatusAllProjects/countShippedTodayAllProjects/listRecentInitiatives. tests: store 8/8, api 6/6. recommendations.updatedAt=SECONDS, initiatives=MS.
- Frontend: components/stats/OrchestratorActivity.tsx (175 lines) wired under BridgeOverview in StatsPage.
- REBUILT (exit 0): route live, server online, smoke OK. require('@/...') instrumentation caveat RESOLVED — built+booted fine.
- Playwright /stats verified: "Orchestrator" panel renders with flag badges (Tuning/Engine/Mining), "engine off" note, Queued/Running/Shipped-today + 24h action stats, and REAL recent boosts ("Boosted qa/improve/refactor-split in smart mode"). 0 console errors.
- All in working tree, NOT committed (per user).

## Goal 3: Harden the Miner ("żeby było super") — COMPLETE
Refactored lib/orchestrator/initiative-probes.ts into pure, tested helpers (isMineableSourceFile/todoFindings/lintFindings) + thin exec wrappers. Fixed 3 noise sources found via real dry-run:
1. Vendored code: switched TODO probe grep -r -> `git grep` (skips submodules: bonker/clawdit foundry libs were submodules). + EXCLUDED_PATH_RE for committed vendored/generated/dist, + first-party-roots-only filter.
2. Lint false-positive: lintFindings() skips pnpm/toolchain preflight failures (deps out of date, missing module/script) — only files on positive eslint evidence.
3. Self-match + prose/string: SELF_PATH_RE excludes the engine's own files; TODO marker tightened to actionable convention (TODO:/FIXME:/TODO() — catches mid-comment real markers, skips prose "not just a TODO" and string "[NETRUNS TODO]"/"TODO|FIXME".
Dry-run before->after across workspace: bonker 9->0, clawdit 1->0, tamtam 2->0 (was prose), borged 3->2 (now BOTH real: SWR-migrate + test stubs). Test 11/11, type-check+lint clean.
NOTE: in working tree, uncommitted; engine still default-off so no live behavior change until enabled — hardened code goes live on next rebuild (skipped redundant rebuild since engine off).

## Goal 4: UI for the Miner ("gdzie widać co miner robi" + UI-friendly) — COMPLETE
Built a real UI home for the initiative engine (was backend-only before).
- Backend: GET /api/initiatives (flags+counts+backlog list, store helper listAllInitiatives) + GET /api/projects/by-project/[p]/initiatives/preview (DRY-RUN: runs probes live, no persist — works with engine off). Tests 18/18, type-check+lint clean. docs/API.md updated.
- Frontend: app/initiatives/page.tsx + components/InitiativesPage.tsx (286) + components/initiatives/ProjectPreviewRow.tsx (95). Nav link "Initiatives" in Header (after Recommendations). "View backlog ->" link added to /stats OrchestratorActivity panel. Reuses fetchProjects.
- REBUILT (exit 0), Playwright verified: page renders (engine off badge, counts, backlog empty-state), and HERO "Preview mining" on borged ran live and showed exactly the 2 grounded TODOs (app/admin/config/page.tsx + dashboard-stats test) at score 40 — matches the hardened Miner, zero vendored/prose noise. 0 console errors.
- Saved feedback memory: feedback_features_need_ui (build UI surface + dry-run for flag-gated features, don't ship backend-only).
- All working-tree, uncommitted.

## Goal 5: "feature without UI" as an engine capability (TamTam improving TamTam) — COMPLETE
Turned the saved self-improvement lesson into a Miner probe: ui-coverage.
- lib/orchestrator/initiative-probes.ts: detects RECENTLY-ADDED (git log --diff-filter=A, 14-day window) app/api routes with no UI/client reference. Pure helpers (apiRoutePathFromFile, isInternalApiPath, extractApiRefs, isPathCovered prefix-aware, parseAddedRouteFiles, orphanApiFindings) + exec scanner. Refs scope = components/lib/hooks/app minus app/api. Excludes internal kinds (cron/webhook/streaming/etc). Cap 5. Guard: 0 refs -> silent.
- CHORE_SEVERITY: ui-coverage = 25 (advisory).
- Precision proven: borged 174 (blanket) -> 1 (recency: /api/discord/link); tamtam/filmpick 0. 18/18 probe tests, type-check+lint clean.
- Caught 2 real bugs via live dogfooding (visual verify): refs scope missed app/ (Next app-router); `*/` inside a JSDoc closed the comment early.
- REBUILT, Playwright verified live: borged Preview shows ui-coverage "/api/discord/link has no UI surface" (score 25) alongside todos. Loop closed: lesson -> engine capability -> visible in UI -> verified.
- All working-tree, uncommitted.

## Goal 6: working "loop that checks" (mine-only) — COMPLETE + VERIFIED LIVE
Answer to "is it like /loop?": no — the checking loop is the deterministic orchestrator tick (durable, gated), not agentic /loop. Built the safe/controllable version:
- initiative_dispatch_enabled (default true; false = mine-only: discover+fill backlog, no auto-merge).
- initiative_mining_interval_minutes (default 60) + pure mining-throttle helper (shouldMineProject/markProjectMined/getLastMineMap on globalThis) — wired into instrumentation mineInitiatives so it doesn't lint-all-projects every 60s tick.
- 6 initiative settings as UI toggles/inputs on Settings>Pipeline (constants.ts + settings-page-config.ts TAB_LAYOUT/type/defaults).
- FIXED hidden gap: initiative keys were never in PATCH whitelist SETTING_KEYS -> couldn't be saved from UI/API at all. Added all 6 to SETTING_KEYS + validator. Regression test (settings-patch-general 33/33).
- FIXED real blocking bug (the deferred goal-1 caveat): instrumentation initiativeEngineEnabled used require('@/...') which doesn't resolve the alias in bundled instrumentation -> tick threw "a is not a function" every 60s, initiative phases never ran. Made it async + await import; tick awaits it. 2 async regression tests (tick-initiatives 5/5).
- VERIFIED LIVE: enabled engine+dispatch=false via UI/API, post-restart tick mined within ~15s, backlog populated 3 queued initiatives from borged (2 todo + 1 ui-coverage /api/discord/link), zero dispatched/merged. /initiatives shows Engine on/Mining on, Queued 3. No tick errors post-fix.
- LEFT RUNNING in mine-only (engine on, dispatch off) — user's requested "loop that checks", safe. Off-switch: Settings>Pipeline toggles.
