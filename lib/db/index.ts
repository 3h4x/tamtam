import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('[db] DATABASE_URL environment variable is required. Set it to your Postgres connection string (e.g. postgres://user@localhost:5432/tamtam).');
}

// Timeouts + keepalive so a Postgres restart fails fast and the pool self-heals
// instead of handing out dead sockets and hanging every query forever.
export const pool = new Pool({
  connectionString,
  // Concurrent DB pressure (orchestrator tick + health-analysis + fruitfulness
  // queries + agent runs + releases + probe sweep) can saturate a small pool and
  // surface as "timeout exceeded when trying to connect" — which intermittently
  // breaks the tick and release dispatch. Postgres allows 100 connections and
  // steady-state usage sits near ~20 across realms, so 20 per pool leaves ample
  // headroom while absorbing load spikes.
  max: 20,
  connectionTimeoutMillis: 5_000, // cap the wait for a connection; don't block requests indefinitely
  idleTimeoutMillis: 30_000, // recycle idle clients so stale/dead sockets get dropped
  keepAlive: true, // TCP keepalive surfaces a dropped peer quickly
  statement_timeout: 30_000, // server-side cap on any single statement
  query_timeout: 30_000, // client-side cap; rejects a hung query instead of waiting forever
});
pool.on('error', (err) => console.error('[db] idle client error', err));
export const db = drizzle(pool, { schema });
export { schema };
