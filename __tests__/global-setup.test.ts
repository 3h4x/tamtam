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

  it('preserves an ambient DATABASE_URL if already set', async () => {
    process.env.DATABASE_URL = 'postgres://example:password@localhost:5432/already_set';

    const { default: globalSetup } = await import('@/__tests__/global-setup');
    globalSetup();

    expect(process.env.DATABASE_URL).toBe('postgres://example:password@localhost:5432/already_set');
  });
});
