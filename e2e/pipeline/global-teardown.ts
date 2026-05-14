import { spawnSync } from 'child_process';

export default async function globalTeardown(): Promise<void> {
  const databaseUrl =
    process.env.E2E_DATABASE_URL ?? 'postgres://tamtam:tamtam@localhost:5432/tamtam_e2e_pipeline';
  const result = spawnSync('node', ['e2e/pipeline/db-admin.mjs', 'drop'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) {
    throw new Error(`pipeline e2e database teardown failed with status ${result.status || 1}`);
  }
}
