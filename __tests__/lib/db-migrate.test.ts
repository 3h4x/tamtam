import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('db:migrate wrapper', () => {
  it('materializes no-op tracked schema columns on a migration-only database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-db-migrate-'));
    const dbPath = join(dir, 'tamtam.db');
    const { migrateDb } = await import('../../scripts/db-migrate.js') as {
      migrateDb: (options: { dbPath: string; migrationsFolder: string }) => void;
    };

    migrateDb({ dbPath, migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') });

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const jobsColumns = sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
      const projectsColumns = sqlite.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;

      expect(jobsColumns.map((column) => column.name)).toContain('release_deadline_at');
      expect(projectsColumns.map((column) => column.name)).toContain('paused');
    } finally {
      sqlite.close();
    }
  });
});
