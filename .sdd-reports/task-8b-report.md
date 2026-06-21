# Task 8b: Initiative Engine Wiring — Report

## Status: COMPLETE

## Real Export Names Used

### Project enumeration
- **Function:** `listEnabledProjects()` from `@/lib/shared/enabled-projects`
- **Returns:** `EnabledProject[]` synchronously (cache-backed, TTL 10s)
- **Fields used:** `p.name` (slug), `p.path` (filesystem path — also available on the EnabledProject type directly)

### Project path resolution
- **Function:** `resolveProjectPath(projectName: string): string | null` from `@/lib/shared/project-data`
- Used in `mineInitiatives` to convert a project slug to its filesystem path for `runProbes`

### Job status lookup
- **Function:** `getJob(jobId: string): JobData | null` from `@/lib/jobs/storage`
- **Probe:** `probeJobStatus(job: JobData): Promise<'running' | 'done'>` from `@/lib/jobs/probe`
- **Fields read:**
  - `job.finishedAt: number | null` — non-null means job is complete
  - `job.exitCode: number | null` — `0` = success, non-zero = failed
- **Mapping logic:**
  - No job row → `'unknown'`
  - `finishedAt !== null` → `exitCode === 0 ? 'success' : 'failed'`
  - Still running → `probeJobStatus(job)` → if `'done'` re-check exitCode, else `'running'`

## Final Shape of Three Deps

```ts
initiativeEngineEnabled: () => {
  const { getSettings } = require('@/lib/shared/config') as typeof import('@/lib/shared/config');
  return getSettings().initiative_engine_enabled === true;
},

mineInitiatives: async () => {
  // if !mining_enabled, return early
  // listEnabledProjects() → for each: resolveProjectPath → runProbes → admitProject
  // per-project try/catch for isolation
},

dispatchInitiatives: async () => {
  // for each enabled project, try/catch:
  //   1. reconcileRunningInitiatives with getJob + probeJobStatus jobStatus fn
  //   2. shipsTodayCount
  //   3. dispatchTopInitiative with all DispatchDeps wired
  // runInitiative: startInitiativeRun → store.setStatus(id, 'running', { releaseId: jobId })
},
```

## Notes on `require()` in `initiativeEngineEnabled`

The `() => boolean` sync signature makes `await import(...)` impossible. `require()` is safe here because:
1. `@/lib/shared/config` is already in the Node module cache — `loadConfig` (which runs before `initiativeEngineEnabled` is ever called) imports it and calls `initSettings()` each tick.
2. TypeScript accepts the `require(...) as typeof import(...)` cast, and type-check passed cleanly.

## Verification

- `pnpm type-check`: **CLEAN** (no errors, no output beyond the tsc invocation line)
- `pnpm lint`: **CLEAN** (instrumentation-node.ts is outside lint scope per CLAUDE.md, no errors surfaced)
