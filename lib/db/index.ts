import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('[db] DATABASE_URL environment variable is required. Set it to your Postgres connection string (e.g. postgres://user@localhost:5432/tamtam).');
}

export const pool = new Pool({ connectionString, max: 10 });
export const db = drizzle(pool, { schema });
export { schema };
