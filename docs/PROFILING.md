# Profiling — Server, Client, and Turbopack

When the dev server pegs CPU, a browser tab spins, or `pnpm dev` feels heavy — start here. Don't guess; measure.

## When to read this

- `next-server` is at >200% CPU and you don't know why
- A browser tab serving `localhost:1337` is hot in Activity Monitor
- HMR feels slow or the dev server keeps emitting the same file
- You need to capture a reproducible perf artifact before changing code

---

## Quick triage

1. **Where is the CPU?** Open Activity Monitor (or `ps -eo pid,pcpu,command | sort -k2 -rn | head`). Look at the *Process Name* column carefully:
   - `next-server (vXX.X.X)` — the Next dev server. **Server-side problem.** Profile Turbopack/Node.
   - `node /path/to/.../next dev` — the PM2 wrapper. Almost always 0% itself; its child is the real cost.
   - `http://localhost:1337` — a Chromium **renderer process** for an open dashboard tab. **Client-side problem.** Profile React.
   - `claude ...` — a long-running Claude CLI run. Not the dev server; orthogonal.

2. **Is it the server, or a child it spawned?** Tamtam spawns PM2 children (`borged-test-…`, `*-review-…`, `*-fix-…`). Each runs its own command (test runner, Claude CLI). High CPU there is *that command*, not the dev server. `pm2 jlist` + `monit.cpu` shows per-app CPU.

3. **How many cores?** macOS reports per-process CPU as a sum across threads. 800% on a 10-core machine = 8 cores busy. Don't panic from a single number; check thread breakdown with `ps -M -p <pid>`.

---

## Server-side: Turbopack / Next.js dev

### Capture a Turbopack trace

The env var is `NEXT_TURBOPACK_TRACING=1` (not `TURBOPACK_PROFILE`, not `TURBO_TRACE` — those are unrelated tools). Output goes to `.next/dev/trace-turbopack`. The `pnpm dev:profile` script wires this up via PM2 with the right env.

```bash
pnpm dev:profile          # starts Next under PM2 with NEXT_TURBOPACK_TRACING=1
# reproduce the slow state for 20–60 s — short windows are enough
# (a 30 s capture produced a 3.2 GB trace in our worst-case test)
pnpm stop                 # graceful stop flushes the trace file
ls -lh .next/dev/trace-turbopack
```

### Inspect the trace

The Next CLI ships an interactive viewer:

```bash
npx next internal trace .next/dev/trace-turbopack
# then open https://trace.nextjs.org/ in your browser — it connects to the local
# trace server. Switch the top-right toggle from "Aggregated in order" to
# "Spans in order" to see individual events.
```

For multi-GB traces the browser viewer is heavy. A faster first pass is to count event names directly via `strings` — Turbopack writes UTF-8 span names into the binary trace, so high-frequency operations show up as repeated substrings:

```bash
strings -n 8 .next/dev/trace-turbopack | sort | uniq -c | sort -rn | head -40
```

The interesting lines are the operation names (`turbo_tasks_fs`, `apply effects`, `invalidate`, `read file before write`, `write file`) and the per-output-file write paths (`.next/dev/...`). High write counts on the same file = rebuild loop.

### What "rebuild loop" looks like in the trace

A healthy dev session: a few hundred to a few thousand `invalidate` events total during a 30 s capture, and each output file written 1–5 times (initial compile + a couple of HMR cycles).

A pathological session (our reproduction):

| Operation | Count in 30 s | Healthy |
|---|---|---|
| `invalidate` | 169,803 | <1,000 |
| `write file` | 169,778 | <1,000 |
| `_app.js` writes | 17,079 | 1–5 |
| `_error.js` writes | 17,182 | 1–5 |

If the same Pages-Router fallback files (`_app`, `_error`, `[root-of-the-server]__*.js`, `pages/_app/build-manifest.json`) are written thousands of times, Turbopack's persistent FS cache is thrashing. In Next 16 try disabling it:

```ts
// next.config.ts
const nextConfig: NextConfig = {
  serverExternalPackages: ['pg', 'graphile-worker'],
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
};
```

### Flamegraph (V8 CPU profile)

Use this when you need a JS-level **flamegraph** — function-by-function stack attribution, not just operation names. Built on Node's `--cpu-prof` flag, no extra deps.

```bash
pnpm dev:flamegraph        # spawns Next under PM2 with --cpu-prof --cpu-prof-dir=./.profiles
# reproduce the slow state for 10–60 s (shorter is fine; the profile flushes
# on graceful exit, not in real time)
pnpm stop
ls -lh .profiles/          # CPU.YYYYMMDD.HHMMSS.<pid>.<thread>.<seq>.cpuprofile
```

The output is V8's standard `.cpuprofile` format. Two viewers:

- **Chrome DevTools** — open any tab, F12 → Performance → "Load profile…" → pick the file. Shows the standard call tree + flame chart.
- **[speedscope.app](https://www.speedscope.app/)** — drag-drop the file. Better flamegraph UI for big profiles; views: Time Order / Left Heavy / Sandwich. No upload — runs entirely in your browser.

What to look for:
- **Wide, short stacks** at the top of a flame = hot leaves. That's where time is actually spent (JSON.parse, regex, fs.readFileSync, etc.).
- **Wide, tall stacks** = a particular code path called expensively often. Drill down to find the caller you can throttle / cache.
- **Solid blocks of `(garbage collector)` or `(idle)`** — GC pressure (allocate less / reuse buffers) or event-loop starvation (do less synchronous work in handlers).

Because this profiles the JS layer, it's useful for app-code hotspots (`/api/jobs`, `getVerdict`, `parseStreamLines`). It will **not** show Turbopack's Rust-side work — that's where Turbopack tracing (above) takes over.

### Build wall-clock: per-phase timings

`pnpm build` runs through `scripts/build-with-metrics.mjs`, which now drives all three phases (prebuild → next build → postbuild) inside one process and writes a per-phase breakdown to every `data/build-metrics.jsonl` record. Look at `phase_timings_ms` for any individual build and the `top_spans` summary inside `trace_summary`:

```bash
pnpm build:history                        # last 10 builds, summary table
pnpm build:history --raw --limit 3        # raw JSON incl. top_spans
```

Established baselines (113 routes, 18-core macOS, no cache):

| Variant | Wall | run-turbopack | Δ baseline |
|---|---|---|---|
| Baseline (all routes) | 124.8s | 118.6s | — |
| Without `withWorkflow` wrapper | 116.6s | 111.0s | −8s |
| 44 API routes (half disabled) | 76.8s | 73.0s | −48s |
| 0 API routes (only pages + workflow) | 45.0s | 42.5s | −80s |

What that tells us:

- **`run-turbopack` is 95% of the build.** Every other span (`static-check`, `check-page`, `is-page-static`) runs in parallel and lands in <1s wall time.
- **Each API route adds ~0.9–1.1s.** With 87 API routes that's ~80s of the 125s build. The cost is the per-entry-point bundle/chunk/emit work; module dedup keeps shared imports cheap.
- **`withWorkflow` adds ~8s.** Useful as a marker but not the lever.
- **NFT bloat ≠ build wall.** Cutting NFT size with `outputFileTracingExcludes` (skills/docs/, docs/, public/, scripts/, `.disabled` siblings) saves ~14% deploy-bundle size but didn't move the build wall, because NFT tracing already runs in parallel (`parallelServerBuildTraces: true`).

If you want a faster build, the levers in order of leverage are:
1. **Reduce route count** (consolidate small CRUD endpoints) — directly subtracts ~1s per route removed. Only mechanism proven to move the wall.
2. *Probably not* per-route transitive import surgery — see "Levers that did NOT help" below.

### Levers that did NOT help (tested, do not retry)

- **`experimental.optimizePackageImports`** for `drizzle-orm`, `drizzle-orm/pg-core`, `@workflow/next`, `workflow` — went from 124.8s → 129.7s (**+5s**). Turbopack already does its own barrel tree-shaking; the legacy Webpack-era flag adds overhead.
- **Lazy-init `lib/db` via Proxy** so `pg.Pool` constructs on first use — 124.8s → 141.5s (**+17s**). Turbopack bundles based on static `import` statements, not runtime usage, so deferring construction doesn't shrink any bundle. The Proxy indirection actively added work.
- **Removing `withWorkflow` wrapper** — only −8s on a 125s build. Not enough to justify losing the workflow runtime.
- **`outputFileTracingExcludes`** for skills/docs/, docs/, public/, scripts/, `.disabled` siblings — useful for deploy-bundle size (~14% smaller NFTs) but **does not move the build wall** because NFT generation already runs in parallel via `parallelServerBuildTraces: true`.
- **Splitting the `@/lib/jobs/job-storage` barrel** so `markDone` / `runCompletionHooks` / `PIPELINE_STEP_KINDS` had to be imported directly from `@/lib/jobs/lifecycle` — Turbopack already tree-shakes static `export { x } from './y'` re-exports correctly, so the dep graph is identical to the barrel form. The refactor changed 17 callsites + 8 test files for **zero build benefit** and broke 120 tests that relied on the lazy load order around the barrel. Reverted.

### Why the per-route cost is hard to dent

Each API route is its own server entry point. Even with module dedup, Turbopack does per-entry chunking, source-map emission, NFT walking, route-manifest entry, and `check-page` + `is-page-static` (parallel, doesn't block wall). When a route imports anything in the workflow / lib-jobs / lib-db chain, Turbopack lumps it into shared chunks with ~80 sibling routes. That's why an individual route's `route.js.nft.json` lists 800+ files even though most of that is shared bundle, not extra compile work. The "84-sibling NFT leak" we found is this shared-chunking behaviour, not a bug to fix.

### Deep Turbopack trace (build)

For the most expensive question — "what is `run-turbopack` doing for 118s?" — capture the binary trace:

```bash
NEXT_TURBOPACK_TRACING=1 pnpm build:raw   # produces ~1.5 GB .next/trace-turbopack
strings -n 8 .next/trace-turbopack | sort | uniq -c | sort -rn | head -40
strings -n 8 .next/trace-turbopack | grep -E "^\[project\]/" | sort | uniq -c | sort -rn | head -40
```

Useful signals from this repo's last capture: 9433 unique modules processed, 24002 resolve operations, 686 references into `drizzle-orm/pg-core` column types, 530 into `lib/pipeline`, 516 into `lib/jobs`. That's how we saw `@/lib/db` was a per-entry tax.

### Other server-side angles

- **Build-time NFT trace bloat.** `pnpm build` runs `scripts/strip-runtime-data-from-nft.mjs` and then `scripts/check-nft-sizes.mjs` after Next finishes compiling. The strip step removes runtime `data/` entries from the boot-only `instrumentation.js.nft.json`; the guard then scans all `.nft.json` files under `.next/server` and fails when any trace exceeds about 1.5 MB of NFT JSON or 8,000 files. This usually means a server-route dependency has an unbounded dynamic `fs.*` path that Turbopack cannot statically analyze. Fix the call site by adding `/*turbopackIgnore: true*/` next to the runtime-dynamic path argument, or add a narrow `outputFileTracingExcludes` entry in `next.config.ts` for runtime artifact directories that should never ship in route bundles. Do not raise the thresholds unless the top offenders are understood and intentionally bounded.
- **`sample <pid>`** (macOS) for a 5 s call-graph snapshot of any Node process: `sample $(pgrep -P $(pm2 pid tamtam) next-server | head -1) 5 -mayDie`. Look at the top of the output ("Call graph:" section) for the hot stack. Heavy time in `uv__io_poll` / `Builtins_PromiseFulfillReactionJob` usually means the event loop is saturated by JS work, not native syscalls. Lighter than `--cpu-prof` because it doesn't restart the process.
- **`/api/jobs` cost.** Tamtam's `/api/jobs` materializes list rows through `jobToListDict`, a slim serializer that omits log paths and ships prompt previews. It still derives verdicts through `jobToDict`, and `getVerdict` is memoized per finished job (`lib/job-storage.ts:verdictCache`) to avoid re-reading review logs on every poll. If you add per-row work to that endpoint, cache it the same way.
- **PM2 zombie next-server.** If `pm2 restart tamtam` leaves an orphan `next-server` listening on 1337, the new PM2 process errors with EADDRINUSE and the orphan keeps serving stale code. Symptoms: edits don't show up; both ports busy. Fix: `lsof -ti:1337 | xargs kill -9; pm2 delete tamtam; pnpm start`.

---

## Client-side: a dashboard tab burning CPU

If Activity Monitor shows `http://localhost:1337` (the URL itself, not a process name) high, it's a renderer.

### Capture

1. Open the offending tab in Chrome.
2. DevTools → Performance → record 5–10 s while the symptom is happening.
3. Look at the bottom-up summary. Hot stacks usually fall into one of:
   - **`<Markdown>`** re-renders during streaming. The terminal renders the entire growing `streamBuffer` through `react-markdown` on every change — O(n²) work as the buffer grows. Mitigated by rAF-batched store notifications in `lib/terminal-session-store.ts` (see `notify` / `flushNotifications` and the `flushScheduled` flag).
   - **Spinner / elapsed-timer intervals** ticking 10–12 ×/s and rerendering the whole terminal tree. Both are gated on `useDocumentVisible()` (`hooks/useDocumentVisible.ts`), so a hidden tab should idle. If it doesn't, check that the gating effect is still in place in `components/TerminalTab.tsx`.
   - **Polling** (`/api/jobs`, `/api/projects`) returning huge payloads parsed every 5 s. If a single payload is >1 MB, it's a JSON-parse problem more than a render problem — narrow the API response or paginate before optimizing the React tree.

### Sanity checks before profiling

- Hidden tabs should be ~0% CPU. If a backgrounded tab still chews CPU, something in that tab is not visibility-aware. Add `useDocumentVisible()` and gate the loop.
- Multiple dashboard tabs multiply CPU. Close duplicates before drawing conclusions.

---

## Worked example (the 800% incident)

Activity Monitor: `next-server (v16.2.4)` at 720–810% across ~7 worker threads, no client traffic, no test commands running. `sample` showed promise/microtask machinery hot but no obvious culprit. `/api/jobs` returning 6.2 MB in 670 ms cold.

Sequence we followed:

1. Memoized `getVerdict` (`lib/job-storage.ts`). `/api/jobs` warm dropped 670 → 290 ms. CPU **unchanged** — not the root cause, but worth keeping.
2. Speculated about `data/logs/` writes triggering Turbopack's watcher; **no evidence** for it. Did not ship the log_dir move.
3. Captured `NEXT_TURBOPACK_TRACING=1` for 30 s → 3.2 GB binary trace.
4. `strings | sort | uniq -c | sort -rn | head` revealed 17k+ writes of `_app.js` / `_error.js` and 170k `invalidate` events — a Pages-Router fallback rebuild loop inside Turbopack's persistent FS cache, independent of user code.
5. Fix: disable `experimental.turbopackFileSystemCacheForDev` (or upgrade once Vercel ships the bugfix).

The lesson: **don't ship a "fix" until the trace points at it**. Steps 1 and 2 cost time; step 3 was the only one that actually answered the question.

---

## Cleanup

Trace and profile files are huge. Both are gitignored (`.next/dev/trace-turbopack`, `.profiles/*.cpuprofile`) but still consume disk:

```bash
rm -f .next/dev/trace-turbopack .profiles/*.cpuprofile
```

The `predev:profile` and `predev:flamegraph` hooks remove the previous artifact before each capture, so back-to-back runs don't accumulate — but disk fills fast if you forget to `pnpm stop` after a long session.
