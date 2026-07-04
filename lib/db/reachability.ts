import { Client } from 'pg';
import { isDbUnavailableError, isPostgresServerResponse } from '@/lib/db/errors';

// Postgres-reachability gate for background loops.
//
// When Postgres is down, every 30 s the probe sweep used to fire ~14 doomed
// queries and each `try/catch` logged a full `AggregateError` stack — a wall of
// noise that *buried* the real condition instead of surfacing it. This module
// gives background work two things the operator actually needs:
//   1. a way to stop hitting a dead pool (`ensureDbReachable` → skip the tick),
//   2. a single, throttled "Postgres unreachable / reachable again" signal
//      instead of a per-call stack storm (`reportDbError`).
//
// State is module-local by design. The one consumer that must *gate* on it (the
// probe sweep) and its DB-touching sub-tasks run in the same instrumentation
// realm; other realms (API routes) that call `reportDbError` get their own
// per-realm throttle, which still collapses the storm without a `globalThis`
// singleton.

// How often to re-log while the DB stays continuously unreachable. The up->down
// and down->up transitions always log; this only bounds the "still down"
// heartbeat during a long outage so it neither spams nor goes fully silent.
const REPEAT_LOG_INTERVAL_MS = 60_000;

interface ReachabilityState {
  reachable: boolean;
  lastDownLogAt: number;
}

const state: ReachabilityState = { reachable: true, lastDownLogAt: 0 };

function label(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof causeCode === 'string') return causeCode;
  return error instanceof Error ? error.message.split('\n')[0] : 'connection error';
}

function noteUnreachable(context: string, error: unknown): void {
  const wasReachable = state.reachable;
  const now = Date.now();
  state.reachable = false;
  if (wasReachable) {
    console.warn(
      `[db] Postgres unreachable (${label(error)}); pausing background DB work and suppressing repeat errors until it recovers [${context}]`,
    );
    state.lastDownLogAt = now;
  } else if (now - state.lastDownLogAt >= REPEAT_LOG_INTERVAL_MS) {
    console.warn(`[db] Postgres still unreachable (${label(error)}) [${context}]`);
    state.lastDownLogAt = now;
  }
}

function noteReachable(): void {
  if (!state.reachable) {
    state.reachable = true;
    console.warn('[db] Postgres reachable again; resuming background DB work');
  }
}

/** Whether the last probe / reported error left the DB in a reachable state. */
export function isDbCurrentlyReachable(): boolean {
  return state.reachable;
}

/**
 * Called from a background chokepoint that already caught an error. Returns
 * `true` iff the error means Postgres is unreachable — in which case it records
 * the down-state and emits a single throttled warning, and the caller should
 * simply swallow the error (serve stale/empty). Returns `false` for genuine
 * failures so the caller logs them normally.
 */
export function reportDbError(context: string, error: unknown): boolean {
  if (!isDbUnavailableError(error)) return false;
  noteUnreachable(context, error);
  return true;
}

/**
 * Counterpart to {@link reportDbError}: call it from a chokepoint's success path
 * so a realm that only ever reports errors (e.g. the API realm via agents-cache,
 * which never runs the reachability probe) still observes the down->up
 * transition and clears the latched down-state. A no-op while already reachable.
 */
export function reportDbOk(): void {
  noteReachable();
}

// Probe on a DEDICATED single-use connection, NOT the shared app pool. Probing
// through the shared pool is ambiguous: a pool-acquisition timeout can mean
// either a saturated-but-healthy server (all 20 clients busy) or a genuinely
// dead one, so the gate could trust neither a success nor a failure. A private
// connection with short timeouts is unambiguous — it succeeds iff Postgres is
// actually reachable — and it never competes with app traffic for a pool slot.
async function defaultProbe(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return; // no DB configured: nothing to gate
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    statement_timeout: 3_000,
  });
  // A bare pg.Client emits an 'error' event if the socket drops between
  // operations; with no listener Node treats it as unhandled and crashes the
  // process. Swallow it — connect()/query() already surface failures to the
  // caller via their promises.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('select 1');
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Probe Postgres once and update reachability. Returns `false` when the DB is
 * unreachable so a background sweep can skip its DB-touching work this tick
 * instead of firing a cascade of doomed queries. The probe uses a dedicated
 * connection, so pool saturation cannot cause a false positive. We gate on a
 * failure to REACH the server, but NOT when the server responds with a
 * non-connection error (e.g. a connection-cap `53300` refusing this fresh probe
 * connection while the app's pooled connections stay healthy) — treating that as
 * an outage would disable the recovery sweep exactly under connection pressure.
 * Logs only on transitions (up->down, down->up) plus a bounded heartbeat during
 * a sustained outage. The probe is injectable for tests.
 */
export async function ensureDbReachable(probe: () => Promise<void> = defaultProbe): Promise<boolean> {
  try {
    await probe();
  } catch (err) {
    if (isPostgresServerResponse(err) && !isDbUnavailableError(err)) {
      // The server answered (it is reachable); it just rejected this fresh probe
      // connection for a non-connectivity reason (e.g. 53300). Treat as reachable
      // — clear any latch and don't gate the sweep.
      noteReachable();
      return true;
    }
    // `label(err)` surfaces the real cause (code or message) in the log line.
    noteUnreachable('db-reachability-probe', err);
    return false;
  }
  noteReachable();
  return true;
}

/** Test-only: reset the module-local reachability state between cases. */
export function __resetDbReachabilityForTests(): void {
  state.reachable = true;
  state.lastDownLogAt = 0;
}
