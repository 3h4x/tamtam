import { existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('__tests__/global-setup.ts', () => {
  const originalDbPath = process.env.TAMTAM_DB_PATH;

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TAMTAM_DB_PATH;
    else process.env.TAMTAM_DB_PATH = originalDbPath;
    vi.resetModules();
  });

  it('creates a dedicated temporary db path when no ambient path is set', async () => {
    delete process.env.TAMTAM_DB_PATH;

    const { default: globalSetup } = await import('@/__tests__/global-setup');
    globalSetup();

    const dbPath = process.env.TAMTAM_DB_PATH;
    expect(dbPath).toBeTruthy();
    expect(dbPath).toContain(`${tmpdir()}/tamtam-vitest-db-`);
    if (!dbPath) throw new Error('Expected TAMTAM_DB_PATH to be set by globalSetup');
    expect(existsSync(dbPath)).toBe(true);

    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").all();
      expect(tables).toEqual([{ name: 'settings' }]);
    } finally {
      sqlite.close();
    }
  });

  it('fails fast instead of trusting an ambient TAMTAM_DB_PATH', async () => {
    const ambientDir = mkdtempSync(join(tmpdir(), 'tamtam-ambient-db-'));
    process.env.TAMTAM_DB_PATH = join(ambientDir, 'tamtam.db');

    const { default: globalSetup } = await import('@/__tests__/global-setup');

    expect(() => globalSetup()).toThrow(/Refusing to run Vitest with ambient TAMTAM_DB_PATH=/);
  });
});
