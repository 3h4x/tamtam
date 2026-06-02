import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('__tests__/global-setup.ts', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
  });

  it('sets a fallback DATABASE_URL when none is present', async () => {
    delete process.env.DATABASE_URL;

    const { default: globalSetup } = await import('@/__tests__/global-setup');
    globalSetup();

    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toMatch(/tamtam_test/);
  });

  it('overrides an ambient non-test DATABASE_URL so tests cannot touch a live database', async () => {
    // The guard treats any DB whose name does not end in `_test` as production
    // (this is the developer's live `…/tamtam` that vitest loads from `.env`).
    // It must be replaced with the safe test target so a stray real-pool query
    // can't mutate the live database (the schema-drop incident).
    process.env.DATABASE_URL = 'postgres://example:password@localhost:5432/already_set';

    const { default: globalSetup } = await import('@/__tests__/global-setup');
    globalSetup();

    expect(process.env.DATABASE_URL).toBe('postgres://tamtam_test@localhost:5432/tamtam_test');
  });

  it('preserves an ambient DATABASE_URL that already targets a _test database', async () => {
    process.env.DATABASE_URL = 'postgres://ci@localhost:5432/myapp_test';

    const { default: globalSetup } = await import('@/__tests__/global-setup');
    globalSetup();

    expect(process.env.DATABASE_URL).toBe('postgres://ci@localhost:5432/myapp_test');
  });
});
