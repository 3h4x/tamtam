import { enforceTestDatabaseUrl } from '@/__tests__/helpers/guard-database-url';
import { prewarmTestPgDbSnapshots } from '@/__tests__/helpers/test-db';

export default async function globalSetup() {
  // Runs once in the main process before forked workers spawn, so the override
  // is inherited by every worker's process.env. See guard-database-url.ts.
  enforceTestDatabaseUrl();
  await prewarmTestPgDbSnapshots();
}
