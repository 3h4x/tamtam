# Initiative Loop Flags Report

## Status
COMPLETE — all parts implemented, all tests pass, type-check clean, lint clean.

## Files Changed

### lib/shared/config.ts
- Added `initiative_dispatch_enabled: boolean` to `TamTamConfig` interface (with JSDoc comment: "when false, engine still mines + fills backlog but does NOT dispatch/merge (mine-only)")
- Added `initiative_mining_interval_minutes: number` to `TamTamConfig` interface (with JSDoc comment: "minimum minutes between mining the same project")
- Added ALL six initiative keys to `DEFAULTS` (worktree started without any initiative keys):
  - `initiative_engine_enabled: false`
  - `initiative_mining_enabled: true`
  - `initiative_dispatch_enabled: true`
  - `initiative_max_ships_per_day: 3`
  - `initiative_max_backlog_per_project: 50`
  - `initiative_mining_interval_minutes: 60`
- Added parse entries in `buildConfigFromSettingsMap` for all six keys
- Exported `DEFAULTS` (was unexported in worktree; required for test imports)

### __tests__/lib/cli-bin.test.ts
- Added all six initiative keys to the `TamTamConfig` literal in `makeSettings()`:
  - `initiative_engine_enabled: false`
  - `initiative_mining_enabled: true`
  - `initiative_dispatch_enabled: true`
  - `initiative_max_ships_per_day: 3`
  - `initiative_max_backlog_per_project: 50`
  - `initiative_mining_interval_minutes: 60`

### __tests__/shared/initiative-settings.test.ts (new file)
- Created `__tests__/shared/` directory (did not exist in worktree)
- Tests: engine off by default, mining on, caps sane, dispatch enabled by default, mining interval defaults to 60

### lib/orchestrator/mining-throttle.ts (new file)
- `shouldMineProject(project, nowMs, lastMineByProject, intervalMs)` — returns true if never mined or interval elapsed
- `markProjectMined(project, nowMs, lastMineByProject)` — records timestamp

### __tests__/orchestrator/mining-throttle.test.ts (new file)
- Created `__tests__/orchestrator/` directory (did not exist in worktree)
- 6 tests: never-mined → true, within interval → false, at boundary → true, after interval → true, markProjectMined records timestamp, markProjectMined updates on second call

### components/settings/constants.ts
- Added 6 keys to `SettingsFieldKey` union: `initiative_engine_enabled`, `initiative_mining_enabled`, `initiative_dispatch_enabled`, `initiative_max_ships_per_day`, `initiative_max_backlog_per_project`, `initiative_mining_interval_minutes`
- Added `initiatives` subsection to `SUBSECTIONS`: title "Initiative Engine (Autonomous Backlog)", 3-col grid
- Added 6 `FieldDef` entries to `FIELDS` (all `group: 'pipeline'`, `subsection: 'initiatives'`, `span: 1`)
- Added 6 string defaults to `DEFAULTS` record

### components/settings/settings-page-config.ts
- Added 6 initiative keys to `SettingsMap` interface
- Added 6 initiative keys to `SETTINGS_DEFAULTS` object
- Added `{ kind: 'subsection', id: 'initiatives' }` to the `pipeline` TAB_LAYOUT array (inserted between `orchestrator` and `retention`)

## Test Results

```
pnpm test __tests__/shared/initiative-settings.test.ts
  Test Files  1 passed (1)
      Tests  3 passed (3)

pnpm test __tests__/orchestrator/mining-throttle.test.ts
  Test Files  1 passed (1)
      Tests  6 passed (6)
```

## Type-check Result
`pnpm type-check` — clean (no output, exit 0)

## Lint Result
`pnpm lint` — clean (no output, exit 0)

## Pipeline Tab Auto-rendering
The Pipeline tab auto-renders the new `initiatives` subsection without any extra wiring beyond:
1. Adding the subsection to `SUBSECTIONS` in `constants.ts`
2. Adding the subsection entry to `TAB_LAYOUT.pipeline` in `settings-page-config.ts`
3. Adding the field definitions to `FIELDS` with `subsection: 'initiatives'`

`GeneralPipelineTab.tsx` already iterates `TAB_LAYOUT[activeTab]` and calls `renderSubsection(entry.id)` for each subsection entry — it picks up `initiatives` automatically. The renderer infers toggle vs number inputs from the settings VALUE type (string `'true'`/`'false'` → toggle; string number → number input); no explicit `type` field was added to any FieldDef.
