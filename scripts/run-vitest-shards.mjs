#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';

const extraArgs = process.argv.slice(2);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Pick a safe db process-concurrency for THIS host, right now. Running the db
// project across N processes (each maxWorkers:1) is ~2.4x faster end-to-end,
// but N concurrent PGlite forks starved of CPU can wedge V8's WASM trap handler
// into an unrecoverable 100%-CPU spin (see vitest.config.ts `db` project). So
// scale concurrency to the *free* CPU headroom and consume only half of it,
// leaving ~2 cores per concurrent fork so none gets starved mid-operation. A
// release's test phase runs while other agents churn: on a loaded host the free
// headroom is small so this returns 1 (the proven-safe sequential path) and
// cannot trigger the spin; on an idle host it returns up to 4 (~2.4x faster).
function defaultDbConcurrency() {
  const cores = Math.max(1, availableParallelism());
  const cap = Math.max(1, Math.min(4, Math.floor(cores / 3)));
  const load1 = loadavg()[0];
  // loadavg is unavailable (returns 0) on some platforms — treat 0 as "idle".
  if (load1 <= 0) return cap;
  const free = cores - load1;
  return Math.max(1, Math.min(cap, Math.floor(free / 2)));
}

function runVitestSync(args) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--no-color', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    console.error(`vitest terminated with ${result.signal}`);
    process.exit(1);
  }
}

function runVitestAsync(args) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--no-color', ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`vitest terminated with ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

// Run a list of vitest argv batches with at most `concurrency` in flight.
// Returns the worst (last non-zero) exit code seen.
async function runPool(jobs, concurrency) {
  let next = 0;
  let worst = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const code = await runVitestAsync(jobs[index]);
      if (code !== 0) worst = code;
    }
  });
  await Promise.all(lanes);
  return worst;
}

// Explicit argv (e.g. a single targeted file) bypasses the project plan.
if (extraArgs.length > 0) {
  runVitestSync(extraArgs);
  process.exit(0);
}

// The `fast` and `slow` projects contain no PGlite file, so each parallelizes
// safely inside one process via its configured `maxWorkers`. Running them as a
// single invocation each — instead of the old 16-/1-way external shard loop —
// pays the vitest cold-start (transform + import + setup, ~3-7s) once per
// project rather than ~17 times. That cold-start tax, not the tests, was the
// bulk of `pnpm test` wall-clock.
runVitestSync(['--project', 'fast']);
runVitestSync(['--project', 'slow']);

// The `db` project boots Postgres-in-WASM per file. `maxWorkers:1` keeps PGlite
// strictly sequential within a process — the only configuration proven not to
// wedge V8's signal-based WASM trap handler into an unrecoverable 100%-CPU spin
// on Node 24 / macOS arm64 (see vitest.config.ts). The default runs the whole
// db project as ONE such process: identical hang-safety to before, minus the 7
// redundant cold-starts the old sequential 8-shard loop paid for no parallelism
// (the shards ran one-at-a-time, so the split never overlapped anything).
//
// db parallelism is load-adaptive by default (see defaultDbConcurrency): it
// fans out only when the host has CPU headroom and stays at 1 when contended.
// TAMTAM_VITEST_DB_CONCURRENCY pins an explicit value (set 1 to force the
// proven-safe sequential path); TAMTAM_VITEST_DB_SHARDS controls how the file
// set is divided (defaults to the concurrency).
const dbConcurrency = envInt('TAMTAM_VITEST_DB_CONCURRENCY', defaultDbConcurrency());
if (dbConcurrency <= 1) {
  runVitestSync(['--project', 'db']);
  process.exit(0);
}

const dbShards = envInt('TAMTAM_VITEST_DB_SHARDS', dbConcurrency);
const dbJobs = [];
for (let shard = 1; shard <= dbShards; shard += 1) {
  dbJobs.push(['--project', 'db', `--shard=${shard}/${dbShards}`]);
}
const dbExit = await runPool(dbJobs, dbConcurrency);
process.exit(dbExit);
