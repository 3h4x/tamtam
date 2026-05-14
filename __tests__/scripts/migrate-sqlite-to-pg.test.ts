import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

describe('scripts/migrate-sqlite-to-pg --help', () => {
  it('prints usage and exits 0', () => {
    const result = spawnSync('node', ['scripts/migrate-sqlite-to-pg.mjs', '--help'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--from');
    expect(result.stdout).toContain('--truncate');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--only');
  });
});
